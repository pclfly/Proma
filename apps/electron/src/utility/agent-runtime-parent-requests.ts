import { AGENT_RUNTIME_METHODS, createAgentRuntimeRequest } from '@proma/shared'
import type { AgentRuntimeRequest, AgentRuntimeResponse } from '@proma/shared'
import { getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

interface ParentTransport {
  postMessage: (request: AgentRuntimeRequest) => void
  bootId: string
  sessionId?: string
  queryId?: string
}
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}
interface ParentRequestsOptions {
  transport: () => ParentTransport | undefined
  /** 注入虚拟时钟以验证跨120秒及最长等待，不启动真实Electron进程。 */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

/** utility→main能力请求：期限、取消和终态共用一个清理出口。 */
export class ParentCapabilityRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly schedule: NonNullable<ParentRequestsOptions['schedule']>
  constructor(private readonly options: ParentRequestsOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    })
  }
  get size(): number { return this.pending.size }

  request<Result = unknown>(method: string, payload: unknown, signal?: AbortSignal): Promise<Result> {
    const transport = this.options.transport()
    if (!transport) return Promise.reject(new Error('Agent runtime port is not connected'))
    const identity = { sessionId: transport.sessionId, queryId: transport.queryId }
    const request = createAgentRuntimeRequest(method, payload, identity, transport.bootId)
    const tool = payload as { toolName?: unknown; toolCallId?: unknown; input?: { delegationId?: unknown } } | null
    const details = {
      requestId: request.requestId,
      ...(typeof tool?.toolName === 'string' ? { toolName: tool.toolName } : {}),
      ...(typeof tool?.toolCallId === 'string' ? { toolCallId: tool.toolCallId } : {}),
      ...(typeof tool?.input?.delegationId === 'string' ? { delegationId: tool.input.delegationId } : {}),
    }
    return new Promise<Result>((resolve, reject) => {
      let clearTimer = (): void => {}
      let removeAbort = (): void => {}
      const finish = (): boolean => {
        if (!this.pending.delete(request.requestId)) return false
        clearTimer()
        removeAbort()
        return true
      }
      const cancel = (): void => {
        try {
          transport.postMessage(createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL, { requestId: request.requestId }, identity, transport.bootId))
        } catch { /* 断开的transport不能阻止本地Promise结算。 */ }
      }
      const fail = (aborted: boolean): void => {
        if (!finish()) return
        cancel()
        const suffix = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(', ')
        reject(Object.assign(new Error(`Main runtime request ${aborted ? 'aborted' : 'timed out'}: ${method} (${suffix}). Acceptance is unknown; query collaboration status before retrying a continuation.`), {
          name: aborted ? 'AbortError' : 'Error', code: aborted ? 'runtime.parent_request_aborted' : 'runtime.parent_request_timeout', acceptance: 'unknown', ...details,
        }))
      }
      this.pending.set(request.requestId, { resolve: (value) => resolve(value as Result), reject, cleanup: () => { clearTimer(); removeAbort() } })
      clearTimer = this.schedule(() => fail(false), getParentRequestTimeoutMs(method, payload))
      if (signal?.aborted) { fail(true); return }
      if (signal) {
        const abort = (): void => fail(true)
        signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', abort)
      }
      try { transport.postMessage(request) } catch (error) { if (finish()) reject(error) }
    })
  }

  resolve(response: AgentRuntimeResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    pending.cleanup()
    if (response.ok) pending.resolve(response.payload)
    else {
      const error = response.error ?? { code: 'runtime.parent_request_failed', message: `Main request failed: ${response.method}` }
      pending.reject(Object.assign(new Error(error.message), error))
    }
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
  }
}
