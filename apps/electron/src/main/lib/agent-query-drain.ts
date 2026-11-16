export const AGENT_QUERY_DRAIN_FAILED_CODE = 'AGENT_QUERY_DRAIN_FAILED'

export function isAgentQueryDrainError(error: unknown): boolean {
  return error instanceof AgentQueryDrainError || !!(error && typeof error === 'object'
    && 'code' in error && error.code === AGENT_QUERY_DRAIN_FAILED_CODE)
}

export class AgentQueryDrainError extends Error {
  readonly code = AGENT_QUERY_DRAIN_FAILED_CODE
  constructor(cause: unknown) {
    super('无法确认上一轮 Agent 已安全收尾；该会话已停止续发，请重启应用后重试。', { cause })
    this.name = 'AgentQueryDrainError'
  }
}

/**
 * 每个 query attempt 的真实清理屏障。超时仅触发 abort，不是清理完成证据。
 * 显式关闭须依次等待会话级 abort、悬空 next 和 iterator.return 的 finally；不调用全局 dispose。
 */
export class AgentQueryDrain<T> {
  private readonly iterator: AsyncIterator<T>
  private pendingNext: Promise<IteratorResult<T>> | undefined
  private naturallyDone = false
  private cleanupFailure: unknown
  private closePromise: Promise<void> | undefined

  constructor(iterable: AsyncIterable<T>, private readonly abort: () => void | Promise<void>) {
    this.iterator = iterable[Symbol.asyncIterator]()
  }

  next(): Promise<IteratorResult<T>> {
    if (this.closePromise) return Promise.reject(new Error('不能继续读取正在关闭的 Agent query'))
    try {
      // 同步进入首个 next，让 adapter 先登记本轮；不能把启动推到 abort 之后的微任务。
      this.pendingNext = Promise.resolve(this.iterator.next()).then(result => {
        if (result.done) this.naturallyDone = true
        return result
      }).catch(error => {
        if (isAgentQueryDrainError(error)) this.cleanupFailure = error
        throw error
      })
    } catch (error) {
      if (isAgentQueryDrainError(error)) this.cleanupFailure = error
      this.pendingNext = Promise.reject(error)
    }
    return this.pendingNext
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.naturallyDone && !this.cleanupFailure) return Promise.resolve()
    // 先订阅拒绝，避免 abort 失败后悬空 next 的迟到拒绝变成 unhandled rejection。
    const nextSettled = this.pendingNext?.catch(() => {})
    this.closePromise = (async () => {
      await this.abort()
      await nextSettled
      if (!this.iterator.return) throw new Error('Agent query 不提供可确认的关闭方法')
      await this.iterator.return()
      // 自然 next 可能已从失败的 finally 退出；之后 return=done 不会重新执行那个 finally。
      if (this.cleanupFailure) throw this.cleanupFailure
    })().catch(cause => { throw cause instanceof AgentQueryDrainError ? cause : new AgentQueryDrainError(cause) })
    return this.closePromise
  }
}
