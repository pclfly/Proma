/**
 * 网络恢复调度与网络变化监测。
 *
 * 官方 0.22.0：
 * - 恢复请求合并 + 防抖/冷却，避免网络抖动时反复重建会话；
 * - 只有 proxy/dns/connect/stream 类传输错误会触发自动恢复；
 * - 网络接口或代理策略变化时，通过 `createNetworkChangeMonitor` 通知上层。
 */

import { classifyNetworkError } from './network-errors'

export type NetworkRecoveryReason =
  | 'resume'
  | 'online'
  | 'policy-change'
  | 'transport-error'
  | 'user-reconnect'

export interface NetworkRecoveryOptions {
  recover: (reason: NetworkRecoveryReason) => Promise<unknown>
  onFailure?: () => void
  debounceMs?: number
  cooldownMs?: number
}

export interface NetworkRecovery {
  notify: (reason: NetworkRecoveryReason, error?: unknown) => void
  dispose: () => void
}

const RECOVERABLE_TRANSPORT_FAILURES = new Set([
  'proxy-unreachable',
  'dns',
  'connect',
  'stream-interrupted',
])

export function createNetworkRecovery(options: NetworkRecoveryOptions): NetworkRecovery {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let disposed = false
  let lastStarted = -Infinity

  return {
    notify(reason, error) {
      if (disposed || running || timer) return
      if (
        reason === 'transport-error'
        && !RECOVERABLE_TRANSPORT_FAILURES.has(classifyNetworkError(error))
      ) {
        return
      }
      const delay = Math.max(
        options.debounceMs ?? 300,
        (options.cooldownMs ?? 5_000) - (Date.now() - lastStarted),
      )
      timer = setTimeout(() => {
        timer = undefined
        if (disposed) return
        running = true
        lastStarted = Date.now()
        void options.recover(reason)
          .catch(() => options.onFailure?.())
          .finally(() => {
            running = false
          })
      }, delay)
      timer.unref?.()
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      timer = undefined
    },
  }
}

export interface NetworkChangeMonitorOptions {
  sample: () => Promise<string>
  onChange: () => void
  intervalMs?: number
}

/** 周期采样网络指纹；首次采样不触发 onChange。 */
export function createNetworkChangeMonitor(
  options: NetworkChangeMonitorOptions,
): () => void {
  let previous: string | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    try {
      const current = await options.sample()
      if (stopped) return
      if (previous !== undefined && previous !== current) options.onChange()
      previous = current
    } catch {
      // 采样失败不改变基线，下一轮继续。
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void tick()
        }, options.intervalMs ?? 10_000)
        timer.unref?.()
      }
    }
  }

  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
