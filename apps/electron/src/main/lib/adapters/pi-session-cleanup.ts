import { AgentQueryDrainError } from '../agent-query-drain'

interface PiSessionCleanupOptions {
  waitForProducer: () => Promise<void>
  dispose: () => void
  closeDispatcher: () => Promise<void>
  release: () => void
}

/** prompt 结束与 iterator finally 共用同一 Promise，不重复 dispose，也不提前释放运行身份。 */
export function createPiSessionCleanup(options: PiSessionCleanupOptions): () => Promise<void> {
  let cleanup: Promise<void> | undefined
  return () => {
    cleanup ??= (async () => {
      try { await options.waitForProducer() } finally {
        const cleanupErrors: unknown[] = []
        try { options.dispose() } catch (error) { cleanupErrors.push(error) }
        try { await options.closeDispatcher() } catch (error) { cleanupErrors.push(error) }
        try { options.release() } catch (error) { cleanupErrors.push(error) }
        // 保留专用清理错误，区别于普通 producer/模型错误；自然 next 与显式 return 均可识别。
        if (cleanupErrors.length) throw new AgentQueryDrainError(new AggregateError(cleanupErrors, 'Pi 会话资源关闭失败'))
      }
    })()
    return cleanup
  }
}
