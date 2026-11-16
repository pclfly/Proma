/**
 * agent-turn-timing — 轮次墙钟结算
 *
 * 状态栏「工具调用用时」= 轮次墙钟合计 − 模型解码耗时，所以每一轮的墙钟必须在
 * result 到达时立刻结算并挂到该 result 上。只在落盘时补 `_durationMs` 不够：
 * 实时流里的 result 没有计时，用户在轮次结束后仍会读到「暂无」，直到消息刷新才出现。
 *
 * 同一个 query 里可能有连续多轮（排队消息、插话续跑各产生一个 result）。
 * 如果每次都按「当前时间 − query 起点」计算，前一轮的时间会被重复计入，
 * 工具用时被放大。因此结算后立即把起点推进到当前时刻。
 */

import type { SDKMessage } from '@proma/shared'

export interface TurnClock {
  /** 结算自上次结算（或构造）以来的墙钟毫秒数，并把起点推进到 now */
  settle(now?: number): number
  /** 当前已流逝毫秒数，不推进起点 */
  elapsed(now?: number): number
  /** 放弃当前计时并把起点重置到 now（恢复重试用） */
  reset(now?: number): void
}

export function createTurnClock(startedAt: number): TurnClock {
  let turnStartedAt = startedAt
  return {
    settle(now = Date.now()): number {
      const durationMs = Math.max(0, now - turnStartedAt)
      turnStartedAt = now
      return durationMs
    },
    elapsed(now = Date.now()): number {
      return Math.max(0, now - turnStartedAt)
    },
    reset(now = Date.now()): void {
      turnStartedAt = now
    },
  }
}

/**
 * 落盘时决定 result 的 `_durationMs`。
 *
 * result 到达时已经结算过一次（实时流与持久化必须是同一个值）；恢复/重试路径传入的
 * 整轮累计耗时只是兜底，不能覆盖已结算的轮次墙钟，否则多轮 run 的历史会被累计放大。
 */
export function resolveResultDurationMs(existing: unknown, fallback?: number): number | undefined {
  if (typeof existing === 'number' && Number.isFinite(existing) && existing >= 0) return existing
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback
  return undefined
}

/**
 * 把轮次墙钟挂到最后一条待落盘 assistant 上。
 *
 * 用户停止或出错时轮次没有 result 结算；若也没有预览帧可补（例如停在工具执行中），
 * 墙钟就挂到本轮最后一条 assistant 上，状态栏仍能估出工具用时。
 * 待落盘数组在每次 result 后清空，所以命中的 assistant 一定属于当前轮。
 */
export function attachTurnDurationToLastAssistant(
  messages: readonly SDKMessage[],
  turnDurationMs: number | undefined,
): boolean {
  if (turnDurationMs == null || turnDurationMs <= 0) return false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    ;(message as Record<string, unknown>)._turnDurationMs = turnDurationMs
    return true
  }
  return false
}
