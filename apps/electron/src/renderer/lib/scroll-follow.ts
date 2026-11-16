/**
 * 滚动跟随判定（官方 0.22.60）。
 *
 * 任何向上的手势都必须立即停止自动跟随，避免缓慢上滑时被强行拉回底部。
 * 向下手势不改变跟随状态，交给 StickToBottom 在回到底部时恢复。
 */

/** wheel deltaY < 0 表示向上滚动。 */
export function shouldStopScrollFollow(deltaY: number): boolean {
  return Number.isFinite(deltaY) && deltaY < 0
}

/** 触摸手势：只有本次移动比起点更靠下（即手指上滑）时才停止跟随。 */
export function shouldStopScrollFollowOnTouch(startY: number, currentY: number): boolean {
  return Number.isFinite(startY) && Number.isFinite(currentY) && currentY < startY
}
