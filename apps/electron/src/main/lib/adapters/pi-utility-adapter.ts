import { randomUUID } from 'node:crypto'
import type {
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeError,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
} from '@proma/shared'
import {
  AGENT_RUNTIME_METHODS,
} from '@proma/shared'
import type { PermissionResult, CanUseToolOptions } from '../agent-permission-service'
import { AgentRuntimeClient } from '../agent-runtime-client'
import { AgentQueryDrainError } from '../agent-query-drain'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { serializePiQueryInput } from './pi-query-input'
import { NetworkRequestError } from '../network/network-errors'
import { parseUtilityNetworkFailure } from '../network/utility-network-reporting'

type PendingQuery = {
  queryId: string
  sessionId: string
  input: PiAgentQueryOptions
  client: AgentRuntimeClient
  queue: AsyncEventQueue<SDKMessage>
  accepted: boolean
  ended: boolean
  runtimeFailed: boolean
}

interface CapabilityRequest {
  controller: AbortController
  queryId: string
  requestId: string
}

type QueryAbortResponse = {
  accepted: boolean
  completed?: boolean
}

type AsyncEventQueue<T> = {
  push: (value: T) => void
  end: () => void
  fail: (error: unknown) => void
  next: () => Promise<IteratorResult<T>>
}

/**
 * Main-process facade for one utility process per active Agent session.
 * Only serializable query data crosses the boundary; Proma callbacks return
 * through capability RPC so business ownership stays in the main process.
 */
export class PiUtilityAdapter {
  private readonly pendingQueries = new Map<string, PendingQuery>()
  private readonly capabilityAbortControllers = new Map<string, CapabilityRequest>()

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const queryId = randomUUID()
    const client = new AgentRuntimeClient({ sessionId: input.sessionId })
    const pending: PendingQuery = {
      queryId,
      sessionId: input.sessionId,
      input,
      client,
      queue: createAsyncEventQueue<SDKMessage>(),
      accepted: false,
      ended: false,
      runtimeFailed: false,
    }
    this.pendingQueries.set(queryId, pending)
    client.setRequestHandler((request) => this.handleRuntimeRequest(request, queryId))
    const unsubscribe = client.onEvent((event) => this.handleRuntimeEvent(event))

    try {
      // 网络运行时在测试/CLI/旧环境中可能不可用；不因此阻断 Agent 查询。
      let networkEpoch = 0
      let routeEpoch = 0
      try {
        const { getRouteEpoch, systemNetwork } = await import('../network/system-network-runtime')
        await systemNetwork.ensureReady()
        networkEpoch = systemNetwork.snapshot().networkEpoch
        routeEpoch = getRouteEpoch()
      } catch {
        // 保持 epoch 0；utility 侧仍可独立运行。
      }
      await client.call(
        AGENT_RUNTIME_METHODS.QUERY_START,
        {
          queryId,
          input: serializePiQueryInput(input),
          networkEpoch,
          routeEpoch,
        },
        { queryId },
      )
      pending.accepted = true

      while (true) {
        const result = await pending.queue.next()
        if (result.done) return
        yield result.value
      }
    } catch (error) {
      pending.queue.fail(error)
      throw error
    } finally {
      pending.ended = true
      unsubscribe()
      this.pendingQueries.delete(queryId)
      if (pending.accepted && !pending.runtimeFailed) {
        await client.call(
          AGENT_RUNTIME_METHODS.QUERY_ABORT,
          { queryId, sessionId: input.sessionId },
          { queryId, timeoutMs: 5_000 },
        ).catch(() => {})
      }
      await this.stopRuntime(pending)
    }
  }

  async abort(sessionId: string): Promise<void> {
    // A recovery iterator can be late to release its runtime. Abort every
    // matching query rather than assuming the first map entry owns the session.
    const aborts: Promise<void>[] = []
    for (const pending of this.pendingQueries.values()) {
      if (pending.sessionId !== sessionId) continue
      this.abortCapabilitiesForQuery(pending.queryId)
      aborts.push(pending.client.call<QueryAbortResponse>(
        AGENT_RUNTIME_METHODS.QUERY_ABORT,
        { queryId: pending.queryId, sessionId },
        { queryId: pending.queryId, timeoutMs: 5_000 },
      ).then(async (result) => {
        if (result.completed === false) {
          await this.failStoppedQuery(pending, new Error('停止 Agent 超时，已关闭卡住的运行时'))
          return
        }
        // QUERY_ABORT confirms the utility query has ended. Close its process
        // before resolving deletion's stop-and-drain barrier instead of relying
        // on the async iterator's later finally block.
        await this.stopRuntime(pending)
      }).catch(async (error) => {
        console.warn(`[PiUtilityAdapter] abort failed: sessionId=${sessionId}`, error)
        await this.failStoppedQuery(pending, error)
      }))
    }
    await Promise.all(aborts)
  }

  private async failStoppedQuery(pending: PendingQuery, error: unknown): Promise<void> {
    if (!pending.ended && !pending.runtimeFailed) {
      pending.runtimeFailed = true
      this.abortCapabilitiesForQuery(pending.queryId)
      pending.queue.fail(error)
    }
    await this.stopRuntime(pending)
  }

  /**
   * 子进程退出未被确认时不能把 query 当作已收尾；用专用清理错误让上层隔离该会话，
   * 而不是把“已发送 kill”当成“旧运行时已停止写入”。
   */
  private async stopRuntime(pending: PendingQuery): Promise<void> {
    try {
      await pending.client.stop()
    } catch (error) {
      throw new AgentQueryDrainError(error)
    }
  }

  private abortCapabilitiesForQuery(queryId: string): void {
    for (const [requestId, capability] of this.capabilityAbortControllers) {
      if (capability.queryId !== queryId) continue
      capability.controller.abort()
      this.capabilityAbortControllers.delete(requestId)
    }
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) throw new Error('当前会话没有正在运行的 Agent')
    const { onAccepted: _onAccepted, ...serializableOptions } = options ?? {}
    await pending.client.call(
      AGENT_RUNTIME_METHODS.QUERY_SEND_QUEUED_MESSAGE,
      { sessionId, message, options: serializableOptions },
      { queryId: pending.queryId },
    )
    options?.onAccepted?.()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) return
    await pending.client.call(
      AGENT_RUNTIME_METHODS.QUERY_SET_PERMISSION_MODE,
      { sessionId, mode },
      { queryId: pending.queryId },
    )
  }

  dispose(): void {
    for (const pending of this.pendingQueries.values()) {
      pending.runtimeFailed = true
      pending.queue.fail(new Error('Agent utility stopped'))
      // stop 现在可能在退出未确认时拒绝；应用退出阶段只记录，不能产生 unhandled rejection。
      void pending.client.stop().catch((error: unknown) => {
        console.warn(`[PiUtilityAdapter] 停止运行时进程失败: sessionId=${pending.sessionId}`, error)
      })
    }
    this.pendingQueries.clear()
    for (const { controller } of this.capabilityAbortControllers.values()) controller.abort()
    this.capabilityAbortControllers.clear()
  }

  private registerCapability(requestId: string, queryId: string): CapabilityRequest {
    const key = JSON.stringify([queryId, requestId])
    if (this.capabilityAbortControllers.has(key)) throw new Error('Duplicate active Agent capability request')
    const capability = { controller: new AbortController(), queryId, requestId }
    this.capabilityAbortControllers.set(key, capability)
    return capability
  }

  private releaseCapability(capability: CapabilityRequest): void {
    const key = JSON.stringify([capability.queryId, capability.requestId])
    if (this.capabilityAbortControllers.get(key) === capability) this.capabilityAbortControllers.delete(key)
  }

  async handleRuntimeRequest(request: AgentRuntimeRequest, originQueryId?: string): Promise<unknown> {
    const payload = request.payload as Record<string, unknown> | undefined
    const queryId = typeof payload?.queryId === 'string' ? payload.queryId : undefined
    const pending = queryId ? this.pendingQueries.get(queryId) : undefined

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL) {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      const owner = originQueryId ?? request.queryId ?? queryId
      const matches = owner
        ? [this.capabilityAbortControllers.get(JSON.stringify([owner, requestId]))].filter((item): item is CapabilityRequest => Boolean(item))
        : Array.from(this.capabilityAbortControllers.values()).filter((item) => item.requestId === requestId)
      if (matches.length === 1) matches[0]!.controller.abort()
      return { accepted: true }
    }

    if (originQueryId && queryId !== originQueryId) throw new Error('Agent capability belongs to another query transport')
    if (!pending) throw new Error(`No active Agent query: ${queryId ?? 'unknown'}`)

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL) {
      if (!pending.input.canUseTool) throw new Error(`No canUseTool handler: ${pending.sessionId}`)
      const capability = this.registerCapability(request.requestId, pending.queryId)
      const { controller } = capability
      try {
        const options = (payload?.options && typeof payload.options === 'object' ? payload.options : {}) as Record<string, unknown>
        return await pending.input.canUseTool(
          String(payload?.toolName ?? ''),
          asRecord(payload?.input),
          { ...options, signal: controller.signal } as CanUseToolOptions,
        ) as PermissionResult
      } finally {
        this.releaseCapability(capability)
      }
    }

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL) {
      const toolName = String(payload?.toolName ?? '')
      const tool = pending.input.customTools?.find((candidate) => candidate.name === toolName)
      if (!tool) throw new Error(`No custom tool handler: ${toolName}`)
      const capability = this.registerCapability(request.requestId, pending.queryId)
      const { controller } = capability
      try {
        const execute = tool.execute as unknown as (
          toolCallId: string,
          input: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<unknown>
        return await execute(String(payload?.toolCallId ?? ''), asRecord(payload?.input), controller.signal)
      } finally {
        this.releaseCapability(capability)
      }
    }

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CODEX_OAUTH_REFRESHED) {
      await pending.input.onCodexOAuthCredentialsRefreshed?.(payload?.credentials as never)
      return { accepted: true }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_GITHUB_COPILOT_OAUTH_REFRESHED) {
      await pending.input.onGithubCopilotOAuthCredentialsRefreshed?.(payload?.credentials as never)
      return { accepted: true }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_XAI_OAUTH_REFRESHED) {
      await pending.input.onXaiOAuthCredentialsRefreshed?.(payload?.credentials as never)
      return { accepted: true }
    }

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN
      || request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_FINISH
      || request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_WITNESS) {
      // 不信 payload 自称的 query：envelope 与已解析的 pending 必须一致。
      if (request.queryId !== pending.queryId || payload?.sessionId !== pending.sessionId
        || (request.sessionId !== undefined && request.sessionId !== pending.sessionId)) {
        throw new Error('Knowledge mutation capability belongs to another query')
      }
      const observer = pending.input.knowledgeMutationObserver
      const mutation = payload?.request
      if (!observer || !mutation || typeof mutation !== 'object') {
        return request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN ? null : { accepted: false }
      }
      const capability = this.registerCapability(request.requestId, pending.queryId)
      const { signal } = capability.controller
      try {
        if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_WITNESS) {
          if (request.sessionId !== pending.sessionId || !observer.readWitness) return undefined
          const input = mutation as Record<string, unknown>
          if (typeof input.ticketId !== 'string' || typeof input.toolCallId !== 'string'
            || typeof input.path !== 'string' || input.path.length > 32768) return undefined
          const witness = await observer.readWitness({ ticketId: input.ticketId, toolCallId: input.toolCallId, path: input.path }, signal)
          return signal.aborted ? undefined : witness
        }
        if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN) {
          const ticket = await observer.begin(mutation as never, signal)
          return signal.aborted ? null : ticket
        }
        await observer.finish(mutation as never, signal)
        return { accepted: !signal.aborted }
      } finally {
        this.releaseCapability(capability)
      }
    }

    throw new Error(`Unsupported Agent runtime request: ${request.method}`)
  }

  private findPending(sessionId: string): PendingQuery | undefined {
    return Array.from(this.pendingQueries.values()).find((item) => item.sessionId === sessionId)
  }

  private handleRuntimeEvent(event: AgentRuntimeEvent): void {
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_CRASHED) {
      const error = toRuntimeError(event.payload)
      const failed = Array.from(this.pendingQueries.values())
        .filter((pending) => pending.sessionId === event.sessionId)
      for (const pending of failed) {
        pending.runtimeFailed = true
        pending.queue.fail(error)
      }
      for (const [requestId, capability] of this.capabilityAbortControllers) {
        if (failed.some((pending) => pending.queryId === capability.queryId)) {
          capability.controller.abort()
          this.capabilityAbortControllers.delete(requestId)
        }
      }
      return
    }

    const payload = event.payload as Record<string, unknown> | undefined
    const queryId = event.queryId
      ?? (typeof payload?.queryId === 'string' ? payload.queryId : undefined)
    if (!queryId) return
    const pending = this.pendingQueries.get(queryId)
    if (!pending) return

    if (event.method === AGENT_RUNTIME_METHODS.EVENT_NETWORK_FAILURE) {
      void (async () => {
        const { networkDiagnostics, networkRecovery, systemNetwork } = await import('../network/system-network-runtime')
        const notice = parseUtilityNetworkFailure(payload, systemNetwork.snapshot().networkEpoch)
        if (!notice) return
        networkDiagnostics.recordUtilityFailure(notice)
        networkRecovery.notify('transport-error', new NetworkRequestError(notice.failure, notice.scope))
      })().catch(() => undefined)
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY) {
      const message = payload?.message
      if (message && typeof message === 'object') pending.queue.push(message as SDKMessage)
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_END) {
      pending.queue.end()
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_ERROR) {
      pending.queue.fail(toRuntimeError(payload?.error))
      return
    }
    if (event.method !== AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK) return

    const callback = payload?.callback
    const callbackPayload = payload?.payload as Record<string, unknown> | undefined
    switch (callback) {
      case 'session_id':
        pending.input.onSessionId?.(String(callbackPayload?.sdkSessionId ?? ''), callbackPayload?.sessionFile as string | undefined)
        break
      case 'pi_entry_bindings':
        pending.input.onPiEntryBindings?.((callbackPayload?.bindings ?? {}) as Record<string, string>)
        break
      case 'model_resolved':
        pending.input.onModelResolved?.(String(callbackPayload?.model ?? ''))
        break
      case 'context_window':
        pending.input.onContextWindow?.(Number(callbackPayload?.contextWindow ?? 0))
        break
      case 'retry':
        pending.input.onRetry?.(callbackPayload?.update as never)
        break
      case 'skill_activated':
        pending.input.onSkillActivated?.(
          (callbackPayload?.activations ?? []) as never,
          String(callbackPayload?.userMessageUuid ?? ''),
        )
        break
    }
  }
}

function createAsyncEventQueue<T>(): AsyncEventQueue<T> {
  const values: T[] = []
  const waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = []
  let ended = false
  let failure: unknown

  return {
    push(value) {
      if (ended || failure !== undefined) return
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ done: false, value })
      else values.push(value)
    },
    end() {
      if (ended || failure !== undefined) return
      ended = true
      while (waiters.length > 0) waiters.shift()!.resolve({ done: true, value: undefined })
    },
    fail(error) {
      if (ended || failure !== undefined) return
      failure = error
      while (waiters.length > 0) waiters.shift()!.reject(error)
    },
    async next() {
      if (values.length > 0) return { done: false, value: values.shift()! }
      if (failure !== undefined) throw failure
      if (ended) return { done: true, value: undefined }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function toRuntimeError(value: unknown): Error {
  if (value && typeof value === 'object' && typeof (value as AgentRuntimeError).message === 'string') {
    const error = new Error((value as AgentRuntimeError).message)
    Object.assign(error, value)
    return error
  }
  return new Error(typeof value === 'string' ? value : 'Agent utility query failed')
}
