/**
 * 网络路由切换后的卡死看门狗。
 *
 * 官方 0.22.0：网络切换后旧连接可能永远不返回；watchdog 观察 routeEpoch，
 * 若切换后长时间没有新数据，主动触发 onStall 让上层中断请求。
 */

export const ROUTE_CHANGE_STALL_MS = 10_000
export const ROUTE_STALL_ERROR_MESSAGE = 'net::ERR_NETWORK_CHANGED: connection lost after network change'

export class RouteStallError extends Error {
  override name = 'RouteStallError'

  constructor() {
    super(ROUTE_STALL_ERROR_MESSAGE)
  }
}

export interface StallWatchdogOptions {
  routeEpoch: () => number | undefined
  stallMs?: number
  tickMs?: number
  now?: () => number
  onStall: () => void
}

export interface StallWatchdog {
  progress: () => void
  stop: () => void
}

export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
  const now = options.now ?? Date.now
  const stallMs = options.stallMs ?? ROUTE_CHANGE_STALL_MS
  const read = (): number | undefined => {
    try {
      return options.routeEpoch()
    } catch {
      return undefined
    }
  }

  let baseline = read()
  let changedAt: number | undefined
  let lastProgressAt = now()
  let stopped = false

  const stop = (): void => {
    stopped = true
    clearInterval(timer)
  }

  const timer = setInterval(() => {
    if (stopped) return
    const current = read()
    if (current === undefined) return
    if (baseline === undefined) {
      baseline = current
      return
    }
    if (changedAt === undefined && current !== baseline) changedAt = now()
    if (changedAt !== undefined && now() - Math.max(changedAt, lastProgressAt) >= stallMs) {
      stop()
      try {
        options.onStall()
      } catch {
        // onStall 的异常不能打断看门狗生命周期。
      }
    }
  }, options.tickMs ?? 1_000)
  timer.unref?.()

  return {
    progress(): void {
      if (stopped) return
      lastProgressAt = now()
      if (changedAt !== undefined) {
        baseline = read() ?? baseline
        changedAt = undefined
      }
    },
    stop,
  }
}
