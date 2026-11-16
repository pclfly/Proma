/**
 * 自动更新检查调度。
 *
 * 官方 0.22.0：
 * - 启动后 10–60 秒随机首次检查，之后约每小时一次并带 ±10% 抖动；
 * - 窗口激活/网络恢复可提前检查，但 15 分钟内刚完成则不重复；
 * - 同一时间只允许一个检查在途，dispose 后不再安排。
 */

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000
export const UPDATE_CHECK_JITTER_RATIO = 0.1
export const UPDATE_CHECK_COOLDOWN_MS = 15 * 60 * 1_000
export const INITIAL_CHECK_MIN_DELAY_MS = 10 * 1_000
export const INITIAL_CHECK_MAX_DELAY_MS = 60 * 1_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface UpdateCheckSchedulerOptions {
  check: () => void | Promise<void>
  intervalMs?: number
  jitterRatio?: number
  cooldownMs?: number
  initialMinDelayMs?: number
  initialMaxDelayMs?: number
  now?: () => number
  random?: () => number
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
}

export interface UpdateCheckScheduler {
  start: () => void
  notifyActive: () => void
  notifyOnline: () => void
  dispose: () => void
}

export function createUpdateCheckScheduler(
  options: UpdateCheckSchedulerOptions,
): UpdateCheckScheduler {
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  const jitterRatio = options.jitterRatio ?? UPDATE_CHECK_JITTER_RATIO
  const cooldownMs = options.cooldownMs ?? UPDATE_CHECK_COOLDOWN_MS
  const initialMinDelayMs = options.initialMinDelayMs ?? INITIAL_CHECK_MIN_DELAY_MS
  const initialMaxDelayMs = options.initialMaxDelayMs ?? INITIAL_CHECK_MAX_DELAY_MS
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const schedule = options.setTimeoutFn ?? setTimeout
  const cancel = options.clearTimeoutFn ?? clearTimeout

  let timer: TimerHandle | null = null
  let started = false
  let disposed = false
  let lastCompletedAt: number | null = null
  let inFlight: Promise<void> | null = null

  const clearTimer = (): void => {
    if (!timer) return
    cancel(timer)
    timer = null
  }

  const jitteredDelay = (): number => {
    const factor = 1 + (random() * 2 - 1) * jitterRatio
    return Math.max(0, Math.round(intervalMs * factor))
  }

  const initialDelay = (): number => {
    const min = Math.max(0, initialMinDelayMs)
    const max = Math.max(min, initialMaxDelayMs)
    return Math.round(min + (max - min) * random())
  }

  const runCheck = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = Promise.resolve()
      .then(options.check)
      .catch((error) => {
        console.warn('[更新] 定时检查未完成，将在下个周期重试:', error)
      })
      .finally(() => {
        lastCompletedAt = now()
        inFlight = null
      })
    return inFlight
  }

  const schedulePeriodicCheck = (): void => {
    if (disposed) return
    clearTimer()
    timer = schedule(() => {
      timer = null
      void runCheck().finally(schedulePeriodicCheck)
    }, jitteredDelay())
  }

  const shouldSkipRecoveryCheck = (): boolean => {
    if (inFlight) return false
    return lastCompletedAt !== null && now() - lastCompletedAt < cooldownMs
  }

  const notifyRecovery = (): void => {
    if (disposed || !started || shouldSkipRecoveryCheck()) return
    void runCheck()
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      timer = schedule(() => {
        timer = null
        void runCheck().finally(schedulePeriodicCheck)
      }, initialDelay())
    },
    notifyActive: notifyRecovery,
    notifyOnline: notifyRecovery,
    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
