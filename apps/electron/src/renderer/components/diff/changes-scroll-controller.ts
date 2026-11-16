export interface ChangesScrollTarget { scrollTop: number; scrollHeight: number; clientHeight: number }

/** 独立于React渲染的恢复状态；恢复滚动和用户滚动不可相互覆盖。 */
export function createChangesScrollController(
  element: ChangesScrollTarget,
  read: () => number,
  save: (top: number) => void,
  schedule: (callback: () => void) => number,
  cancel: (id: number) => void,
) {
  let restoring = true, controlled = false, disposed = false
  let frame: number | undefined
  let pending: number | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    if (pending !== undefined) { save(pending); pending = undefined }
  }
  return {
    restore(ready: boolean): void {
      if (disposed || controlled) return
      if (frame !== undefined) cancel(frame)
      restoring = true
      const desired = read()
      element.scrollTop = desired
      if (!ready) return
      frame = schedule(() => { frame = undefined; restoring = false })
    },
    takeControl(): void { controlled = true; restoring = false },
    scroll(): void {
      if (disposed || restoring) return
      // 浏览器因尚未就绪的布局clamp到0时，不能覆盖等待恢复的位置。
      const desired = read()
      if (!controlled && element.scrollTop !== desired && element.scrollHeight - element.clientHeight < desired) return
      if (!controlled && element.scrollTop === desired) return
      controlled = true
      pending = element.scrollTop
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(flush, 100)
    },
    dispose(): void { disposed = true; if (frame !== undefined) cancel(frame); flush() },
  }
}
