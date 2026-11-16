import type { WorkspaceMemoryFileChange } from '@proma/shared'

interface Subscriber { callback: (change: WorkspaceMemoryFileChange) => void; onError?: (error: unknown) => void }
/** unknown 表示 start/stop 的回复失败、主进程侧真实状态不可知；下一次订阅/释放时再收敛一次。 */
type WatchState = 'idle' | 'active' | 'unknown'
interface SubscriptionEntry { subscribers: Set<Subscriber>; state: WatchState; busy: boolean; detach: () => void }
interface SubscriptionDependencies {
  start: (workspaceSlug: string) => Promise<void>
  stop: (workspaceSlug: string) => Promise<void>
  listen: (workspaceSlug: string, callback: (change: WorkspaceMemoryFileChange) => void) => () => void
  reportError: (error: unknown) => void
}

/**
 * 同一 renderer/workspace 复用一个 main 订阅并做 refcount。
 * start/stop 串行收敛，不让 StrictMode 的迟到回包停掉新消费者；失败不静默，也不忙循环重试。
 */
export function createWorkspaceMemoryWatchSubscriptions(dependencies: SubscriptionDependencies) {
  const entries = new Map<string, SubscriptionEntry>()
  const report = (entry: SubscriptionEntry, error: unknown): void => {
    dependencies.reportError(error)
    for (const subscriber of [...entry.subscribers]) { try { subscriber.onError?.(error) } catch (callbackError) { dependencies.reportError(callbackError) } }
  }
  const reconcile = (workspaceSlug: string, entry: SubscriptionEntry): void => {
    if (entry.busy) return
    entry.busy = true
    void (async () => {
      try {
        // 只收敛到目标态；unknown 也视为需要重新对齐，但每次事件最多尝试一次。
        while (true) {
          const wanted = entry.subscribers.size > 0
          if (wanted && entry.state === 'active') break
          if (!wanted && entry.state === 'idle') break
          try {
            if (wanted) { await dependencies.start(workspaceSlug); entry.state = 'active' }
            else { await dependencies.stop(workspaceSlug); entry.state = 'idle' }
          } catch (error) {
            entry.state = 'unknown'
            report(entry, error)
            break
          }
        }
      } finally {
        entry.busy = false
        if (entry.subscribers.size === 0 && entry.state === 'idle') {
          entry.detach()
          if (entries.get(workspaceSlug) === entry) entries.delete(workspaceSlug)
        }
      }
    })()
  }
  return {
    subscribe(workspaceSlug: string, callback: Subscriber['callback'], onError?: Subscriber['onError']): () => void {
      let entry = entries.get(workspaceSlug)
      if (!entry) {
        const created: SubscriptionEntry = { subscribers: new Set(), state: 'idle', busy: false, detach: () => {} }
        created.detach = dependencies.listen(workspaceSlug, change => {
          for (const subscriber of [...created.subscribers]) { try { subscriber.callback(change) } catch (error) { dependencies.reportError(error) } }
        })
        entry = created
        entries.set(workspaceSlug, entry)
      }
      const current = entry
      const subscriber: Subscriber = { callback, onError }
      current.subscribers.add(subscriber)
      reconcile(workspaceSlug, current)
      let disposed = false
      return () => { if (disposed) return; disposed = true; current.subscribers.delete(subscriber); reconcile(workspaceSlug, current) }
    },
  }
}
