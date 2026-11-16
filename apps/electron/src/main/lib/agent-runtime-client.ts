import { join } from 'node:path'
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron'
import { startUtilityProcessWithRetry } from './utility-process-startup'
import {
  AGENT_RUNTIME_BOOTSTRAP_ID,
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  createAgentRuntimeRequest,
  createAgentRuntimeResponse,
  isAgentRuntimeEnvelope,
  serializeAgentRuntimeError,
  type AgentRuntimeEnvelope,
  type AgentRuntimeError,
  type AgentRuntimeEvent,
  type AgentRuntimeHandshakePayload,
  type AgentRuntimePortTransfer,
  type AgentRuntimeRequest,
  type AgentRuntimeResponse,
  type AgentRuntimeState,
} from '@proma/shared'

type RuntimePort = Pick<MessagePortMain, 'close' | 'postMessage' | 'start'> & {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

type RuntimeRequestHandler = (request: AgentRuntimeRequest) => Promise<unknown>

export interface AgentRuntimeClientOptions {
  sessionId: string
  entryPath?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  /** kill 之后等待真实 exit 的上限；超时不是退出证据，只用于把失败限定在有界时间内。 */
  exitConfirmTimeoutMs?: number
}

export interface AgentRuntimeRequestOptions {
  queryId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_EXIT_CONFIRM_TIMEOUT_MS = 5_000

export const AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE = 'AGENT_RUNTIME_EXIT_UNCONFIRMED'

export function isAgentRuntimeExitUnconfirmedError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE
}

function createExitUnconfirmedError(sessionId: string): Error & { code: string } {
  const error = new Error('无法确认 Agent 运行时进程已退出；该会话已停止续发，请重启应用后重试。') as Error & { code: string }
  error.code = AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE
  error.cause = { sessionId }
  return error
}

interface ProcessExitEvidence {
  promise: Promise<void>
  dispose: () => void
}

/** 先监听 exit 再发 shutdown/kill，才能把“已请求停止”与“进程已退出”分开。 */
function observeProcessExit(runtimeProcess: UtilityProcess): ProcessExitEvidence {
  const events = runtimeProcess as unknown as {
    once?: (event: 'exit', listener: (code: number) => void) => void
    on?: (event: 'exit', listener: (code: number) => void) => void
    removeListener?: (event: 'exit', listener: (code: number) => void) => void
  }
  let resolveExit: () => void = () => {}
  const promise = new Promise<void>((resolve) => { resolveExit = resolve })
  const onExit = (): void => resolveExit()
  if (typeof events.once === 'function') events.once('exit', onExit)
  else events.on?.('exit', onExit)
  return { promise, dispose: () => events.removeListener?.('exit', onExit) }
}

async function waitForExitEvidence(evidence: ProcessExitEvidence, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const confirmed = await Promise.race([evidence.promise.then(() => true), timeout])
  if (timer) clearTimeout(timer)
  return confirmed
}

/**
 * One client owns exactly one Pi utility process. Keeping this unit per session
 * prevents a busy Agent from sharing a Node event loop with another Agent.
 */
export class AgentRuntimeClient {
  private readonly sessionId: string
  private readonly entryPath: string
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly startupTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly exitConfirmTimeoutMs: number
  private runtimeProcess: UtilityProcess | undefined
  private port: RuntimePort | undefined
  private generation = 0
  private startPromise: Promise<AgentRuntimeState> | undefined
  private stopPromise: Promise<void> | undefined
  /** 一旦无法证明旧子进程已退出，不能靠后续重复 stop 悄悄恢复成可续发。 */
  private exitUnconfirmed = false
  private bootId = AGENT_RUNTIME_BOOTSTRAP_ID
  private state: AgentRuntimeState = {
    status: 'stopped',
    bootId: AGENT_RUNTIME_BOOTSTRAP_ID,
    pid: null,
    active: false,
    pendingRequests: 0,
  }
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: AgentRuntimeEvent) => void>()
  private requestHandler: RuntimeRequestHandler | undefined

  constructor(options: AgentRuntimeClientOptions) {
    this.sessionId = options.sessionId
    this.entryPath = options.entryPath ?? join(__dirname, 'agent-runtime.cjs')
    this.env = options.env
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.exitConfirmTimeoutMs = options.exitConfirmTimeoutMs ?? DEFAULT_EXIT_CONFIRM_TIMEOUT_MS
  }

  get currentState(): AgentRuntimeState {
    return { ...this.state }
  }

  get isReady(): boolean {
    return this.state.status === 'ready' && this.port !== undefined
  }

  setRequestHandler(handler: RuntimeRequestHandler | undefined): void {
    this.requestHandler = handler
  }

  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  start(): Promise<AgentRuntimeState> {
    if (this.isReady) return Promise.resolve(this.currentState)
    if (this.stopPromise || this.state.status === 'stopping') return Promise.reject(new Error('Agent runtime is shutting down'))
    if (this.startPromise) return this.startPromise
    // 启动 Promise 必须包含失败清理：否则 stop 只等到原始拒绝就以为可以安全收尾。
    const starting = this.startInternal()
    this.startPromise = starting
    const settle = (): void => {
      if (this.startPromise === starting) this.startPromise = undefined
    }
    void starting.then(settle, settle)
    return starting
  }

  private async startInternal(): Promise<AgentRuntimeState> {
    try {
      return await this.spawnAndHandshake()
    } catch (error) {
      const stoppedDuringStart = this.stopPromise !== undefined
        || this.state.status === 'stopped'
      this.port?.close()
      this.port = undefined
      const abandonedChild = this.runtimeProcess
      this.runtimeProcess = undefined
      // 启动失败/取消也要等真实 exit：kill 请求不等于子进程已停止写盘。
      if (abandonedChild) this.exitUnconfirmed ||= !(await this.terminateProcess(abandonedChild))
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
      if (!stoppedDuringStart) {
        this.state = {
          status: 'crashed',
          bootId: AGENT_RUNTIME_BOOTSTRAP_ID,
          pid: null,
          active: false,
          pendingRequests: 0,
          lastError: serializeAgentRuntimeError(error, 'runtime.start_failed'),
        }
      }
      throw error
    }
  }

  async call<Result = unknown, Payload = unknown>(
    method: string,
    payload?: Payload,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<Result> {
    await this.start()
    return this.sendRequest<Result>(method, payload, options)
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (this.exitUnconfirmed) return Promise.reject(createExitUnconfirmedError(this.sessionId))
    if (!this.runtimeProcess && !this.startPromise) return Promise.resolve()

    const runtimeProcess = this.runtimeProcess
    const pendingStart = this.startPromise
    const exitEvidence = runtimeProcess ? observeProcessExit(runtimeProcess) : undefined
    const stopPromise = this.stopRuntime(runtimeProcess, exitEvidence, pendingStart)
    this.stopPromise = stopPromise
    const settle = (): void => {
      if (this.stopPromise === stopPromise) this.stopPromise = undefined
    }
    // 同时处理成功与失败，避免派生的 unhandled rejection。
    void stopPromise.then(settle, settle)
    return stopPromise
  }

  private async stopRuntime(
    runtimeProcess: UtilityProcess | undefined,
    exitEvidence: ProcessExitEvidence | undefined,
    pendingStart: Promise<AgentRuntimeState> | undefined,
  ): Promise<void> {
    const currentGeneration = this.generation
    this.state = { ...this.state, status: 'stopping' }
    try {
      if (this.port) {
        await this.sendRequest(AGENT_RUNTIME_METHODS.SHUTDOWN, undefined, { timeoutMs: 5_000 }).catch(() => {})
      }
    } finally {
      if (currentGeneration === this.generation) this.generation++
      this.port?.close()
      this.port = undefined
      runtimeProcess?.kill()
      this.runtimeProcess = undefined
      this.rejectPending(new Error('Agent runtime stopped'))
      this.state = {
        status: 'stopped',
        bootId: AGENT_RUNTIME_BOOTSTRAP_ID,
        pid: null,
        active: false,
        pendingRequests: 0,
      }
      // 关闭 port / 清理 pending 只阻止迟到 IPC，不等于旧进程已停止执行与写盘。
      const exitConfirmed = exitEvidence
        ? await waitForExitEvidence(exitEvidence, this.exitConfirmTimeoutMs)
        : true
      exitEvidence?.dispose()
      await pendingStart?.catch(() => {})
      if (!exitConfirmed || (!exitEvidence && this.exitUnconfirmed)) {
        this.exitUnconfirmed = true
        throw createExitUnconfirmedError(this.sessionId)
      }
    }
  }

  /** kill 一个确定身份的子进程，并返回是否得到真实退出证据。 */
  private async terminateProcess(child: UtilityProcess): Promise<boolean> {
    const evidence = observeProcessExit(child)
    try { child.kill() } catch { /* 子进程可能已在退出 */ }
    const exited = await waitForExitEvidence(evidence, this.exitConfirmTimeoutMs)
    evidence.dispose()
    return exited
  }

  private async spawnAndHandshake(): Promise<AgentRuntimeState> {
    const generation = ++this.generation
    this.state = { ...this.state, status: 'starting', lastError: undefined }
    const shouldContinueStartup = () =>
      generation === this.generation
      && this.stopPromise === undefined
      && this.state.status === 'starting'
    const runtimeProcess = await startUtilityProcessWithRetry(
      () => utilityProcess.fork(this.entryPath, [], {
        serviceName: 'Proma Runtime',
        env: { ...process.env, ...this.env, PROMA_AGENT_SESSION_ID: this.sessionId },
      }),
      { shouldContinue: shouldContinueStartup },
    )
    if (!shouldContinueStartup()) {
      // fork 已返回 child 但 stop 可能发生在本赋值之前；此时也必须等真实 exit。
      this.exitUnconfirmed ||= !(await this.terminateProcess(runtimeProcess))
      throw new Error('Agent runtime startup cancelled')
    }
    this.runtimeProcess = runtimeProcess
    const processEvents = runtimeProcess as unknown as {
      on(event: 'exit', listener: (code: number) => void): void
    }
    processEvents.on('exit', (code) => {
      if (generation !== this.generation || this.runtimeProcess !== runtimeProcess) return
      this.handleProcessExit(code)
    })
    runtimeProcess.on('error', (type, location, report) => {
      if (generation !== this.generation || this.runtimeProcess !== runtimeProcess) return
      this.handleRuntimeFailure({
        code: 'runtime.process_error',
        message: `Agent runtime fatal error: ${type}`,
        details: { location, report },
      })
    })

    const channel = new MessageChannelMain()
    const port = channel.port2 as unknown as RuntimePort
    this.port = port
    port.on('message', (event) => {
      if (generation !== this.generation || this.runtimeProcess !== runtimeProcess || this.port !== port) return
      this.handlePortMessage(event.data)
    })
    port.start()

    const transfer: AgentRuntimePortTransfer = {
      type: 'proma-agent-runtime-port',
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    }
    runtimeProcess.postMessage(transfer, [channel.port1])

    const handshake = await this.sendRequest<AgentRuntimeHandshakePayload>(
      AGENT_RUNTIME_METHODS.HANDSHAKE,
      { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION },
      { timeoutMs: this.startupTimeoutMs },
    )
    if (generation !== this.generation || this.runtimeProcess !== runtimeProcess || this.port !== port) {
      throw new Error('Agent runtime stopped during handshake')
    }
    this.bootId = handshake.state.bootId
    this.state = { ...handshake.state, status: 'ready' }
    return this.currentState
  }

  private sendRequest<Result, Payload = unknown>(
    method: string,
    payload?: Payload,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<Result> {
    const port = this.port
    if (!port) return Promise.reject(new Error('Agent runtime port is not connected'))

    const request = createAgentRuntimeRequest(method, payload, {
      sessionId: this.sessionId,
      queryId: options.queryId,
    }, method === AGENT_RUNTIME_METHODS.HANDSHAKE ? AGENT_RUNTIME_BOOTSTRAP_ID : this.bootId)
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs

    return new Promise<Result>((resolve, reject) => {
      let removeAbortListener = (): void => {}
      const cleanup = (): void => {
        clearTimeout(timer)
        removeAbortListener()
      }
      const timer = setTimeout(() => {
        if (!this.pendingRequests.delete(request.requestId)) return
        cleanup()
        this.state = { ...this.state, pendingRequests: this.pendingRequests.size }
        reject(new Error(`Agent runtime request timed out: ${method}`))
      }, timeoutMs)
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
        cleanup,
      }
      this.pendingRequests.set(request.requestId, pending)
      this.state = { ...this.state, pendingRequests: this.pendingRequests.size }

      if (options.signal) {
        const abort = (): void => {
          if (!this.pendingRequests.delete(request.requestId)) return
          cleanup()
          this.state = { ...this.state, pendingRequests: this.pendingRequests.size }
          reject(new Error(`Agent runtime request aborted: ${method}`))
        }
        if (options.signal.aborted) {
          abort()
          return
        }
        options.signal.addEventListener('abort', abort, { once: true })
        removeAbortListener = () => options.signal?.removeEventListener('abort', abort)
      }

      try {
        port.postMessage(request)
      } catch (error) {
        this.pendingRequests.delete(request.requestId)
        cleanup()
        this.state = { ...this.state, pendingRequests: this.pendingRequests.size }
        reject(error)
      }
    })
  }

  private handlePortMessage(rawMessage: unknown): void {
    if (!isAgentRuntimeEnvelope(rawMessage)) return
    const message = rawMessage as AgentRuntimeEnvelope
    if (message.kind === 'request') {
      void this.handleIncomingRequest(message)
      return
    }
    if (message.kind === 'event') {
      if (message.bootId !== this.bootId && message.bootId !== AGENT_RUNTIME_BOOTSTRAP_ID) return
      if (message.method === AGENT_RUNTIME_METHODS.EVENT_STATE && message.payload) {
        this.state = { ...(message.payload as AgentRuntimeState) }
      }
      for (const listener of this.eventListeners) {
        try { listener(message) } catch (error) { console.warn('[AgentRuntime] event listener failed:', error) }
      }
      return
    }
    if (message.kind !== 'response') return
    if (message.method !== AGENT_RUNTIME_METHODS.HANDSHAKE && message.bootId !== this.bootId) return

    const pending = this.pendingRequests.get(message.requestId)
    if (!pending) return
    this.pendingRequests.delete(message.requestId)
    pending.cleanup()
    this.state = { ...this.state, pendingRequests: this.pendingRequests.size }
    if (message.ok) pending.resolve(message.payload)
    else pending.reject(this.errorFromResponse(message))
  }

  private async handleIncomingRequest(request: AgentRuntimeRequest): Promise<void> {
    const port = this.port
    const runtimeProcess = this.runtimeProcess
    const generation = this.generation
    const bootId = this.bootId
    if (!port || request.bootId !== bootId) return
    const isCurrentRuntime = () =>
      generation === this.generation
      && runtimeProcess === this.runtimeProcess
      && port === this.port
      && bootId === this.bootId

    try {
      if (!this.requestHandler) throw new Error(`No main handler for runtime method: ${request.method}`)
      const payload = await this.requestHandler(request)
      // Capability handlers can resolve after stop/restart. Never direct an old
      // runtime response to a replacement port/boot identity.
      if (!isCurrentRuntime()) return
      port.postMessage(createAgentRuntimeResponse(request, { payload }, bootId))
    } catch (error) {
      if (!isCurrentRuntime()) return
      port.postMessage(createAgentRuntimeResponse(request, {
        error: serializeAgentRuntimeError(error, 'runtime.main_handler_failed'),
      }, bootId))
    }
  }

  private errorFromResponse(response: AgentRuntimeResponse): Error {
    const runtimeError = response.error ?? { code: 'runtime.request_failed', message: `Agent runtime request failed: ${response.method}` }
    const error = new Error(runtimeError.message)
    Object.assign(error, runtimeError)
    return error
  }

  private handleRuntimeFailure(error: AgentRuntimeError): void {
    if (this.state.status === 'stopping' || this.state.status === 'stopped') return
    this.state = { ...this.state, status: 'crashed', lastError: error, active: false }
    this.rejectPending(Object.assign(new Error(error.message), error))
    for (const listener of this.eventListeners) {
      listener({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        bootId: this.bootId,
        kind: 'event',
        method: AGENT_RUNTIME_METHODS.EVENT_CRASHED,
        sessionId: this.sessionId,
        payload: error,
      })
    }
  }

  private handleProcessExit(code: number): void {
    if (this.state.status === 'stopping' || this.state.status === 'stopped') return
    this.handleRuntimeFailure({
      code: 'runtime.process_exit',
      message: `Agent runtime exited (code=${code})`,
      retryable: true,
      details: { code, sessionId: this.sessionId },
    })
    this.port?.close()
    this.port = undefined
    this.runtimeProcess = undefined
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pendingRequests.clear()
    this.state = { ...this.state, pendingRequests: 0 }
  }
}
