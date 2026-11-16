export interface FileScrollTarget { scrollTop: number; scrollHeight: number; clientHeight: number }
export interface FileScrollScheduler {
  schedule: (callback: () => void) => () => void
}

function validTop(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0 }
const defaultScheduler: FileScrollScheduler = {
  schedule(callback) {
    const timer = setTimeout(callback, 120)
    return () => clearTimeout(timer)
  },
}

/**
 * Files 恢复与用户滚动分轨：异步目录导致的 clamp 不能覆盖尚未恢复的保存值。
 * 仅用户/搜索接管后的 scroll 才落到会话内存；卸载同步 flush 最后120ms。
 */
export function createFileScrollController(
  element: FileScrollTarget,
  initialTop: number,
  save: (top: number) => void,
  scheduler: FileScrollScheduler = defaultScheduler,
) {
  const desired = validTop(initialTop)
  let controlled = false, disposed = false
  let pendingTop: number | undefined
  let cancelFlush: (() => void) | undefined
  const flush = (): void => {
    cancelFlush?.()
    cancelFlush = undefined
    if (pendingTop === undefined) return
    const next = pendingTop
    pendingTop = undefined
    save(next)
  }
  return {
    restore(): boolean {
      if (disposed || controlled) return true
      const max = Math.max(0, element.scrollHeight - element.clientHeight)
      element.scrollTop = Math.min(desired, max)
      return max >= desired
    },
    takeControl(): void {
      if (disposed) return
      controlled = true
    },
    scroll(): void {
      // 单独的 scroll 无法证明用户意图（包括成功恢复后的内容收缩/滚动锚定）。
      if (disposed || !controlled) return
      pendingTop = validTop(element.scrollTop)
      if (!cancelFlush) cancelFlush = scheduler.schedule(flush)
    },
    dispose(): void {
      if (disposed) return
      // 宿主按 stateKey 独立挂载；cleanup 时此element仍属旧视图，可补采最后native事件。
      if (controlled) pendingTop = validTop(element.scrollTop)
      disposed = true
      flush()
    },
  }
}

/** 窄单来源与宽双来源共用同一 key；不把面板宽度/布局当成文件身份。 */
export function getFileBrowserScrollStateKey(
  sessionId: string,
  view: string,
  roots: readonly { path: string; scope: string }[],
): string {
  const rootKey = roots.map(root => `${root.scope}\u0000${root.path}`).sort().join('\u0001')
  return `${sessionId}\u0002files\u0002${view}\u0002${rootKey}`
}
