/**
 * Pi 流式响应计时。
 *
 * 状态栏要区分「等首 token」和「真正在吐字」：
 * - TTFT（首 token 延迟）= 第一条增量到达 − 请求发出
 * - decode（解码耗时）= 消息结束 − 第一条增量到达
 *
 * 输出速度按 output_tokens / decodeMs 计算，把等待时间排除在分母外，
 * 否则一次长 prompt 的首 token 等待会把整轮速度拉低到没有参考价值。
 *
 * Pi 自带的 message.durationMs 覆盖的是整个响应流（含排队与重试），
 * 直接拿它当解码耗时会让速度偏低，因此这里自己按增量到达时刻计时。
 */

export interface PiResponseTiming {
  /** 首 token 延迟（ms） */
  ttftMs?: number
  /** 解码耗时（ms） */
  decodeMs?: number
}

export interface PiResponseTimingTracker {
  /**
   * 记录一条增量到达。
   * @param uuid - 该 assistant 消息的 uuid
   * @param requestStartedAt - 请求发出时刻（Unix ms，来自消息的 timestamp）
   * @param now - 当前时刻（Unix ms）
   */
  noteDelta(uuid: string, requestStartedAt: number | undefined, now: number): void
  /** 收束一条消息，返回其计时；无可用计时时返回空对象 */
  finish(uuid: string, now: number): PiResponseTiming
  /** 丢弃一条消息的计时记录（native retry 复用同一 uuid 时需重置） */
  forget(uuid: string): void
  /** 清空全部计时记录 */
  reset(): void
}

interface TimingState {
  requestStartedAt?: number
  firstTokenAt?: number
}

export function createPiResponseTimingTracker(): PiResponseTimingTracker {
  const states = new Map<string, TimingState>()

  return {
    noteDelta(uuid, requestStartedAt, now) {
      const state = states.get(uuid) ?? {}
      if (state.requestStartedAt === undefined && typeof requestStartedAt === 'number') {
        state.requestStartedAt = requestStartedAt
      }
      // 只有第一条增量定锚；后续增量不影响再计算
      if (state.firstTokenAt === undefined) state.firstTokenAt = now
      states.set(uuid, state)
    },
    finish(uuid, now) {
      const state = states.get(uuid)
      if (!state) return {}
      const timing: PiResponseTiming = {}
      if (state.firstTokenAt !== undefined) {
        if (state.requestStartedAt !== undefined) {
          const ttftMs = state.firstTokenAt - state.requestStartedAt
          if (Number.isFinite(ttftMs) && ttftMs >= 0) timing.ttftMs = ttftMs
        }
        const decodeMs = now - state.firstTokenAt
        if (Number.isFinite(decodeMs) && decodeMs > 0) timing.decodeMs = decodeMs
      }
      // 收束后不再保留，避免长会话累积
      states.delete(uuid)
      return timing
    },
    forget(uuid) {
      states.delete(uuid)
    },
    reset() {
      states.clear()
    },
  }
}
