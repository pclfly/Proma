/**
 * Utility 进程网络失败上报。
 *
 * 官方 0.22.0：utility 内的 fetch/Chromium 失败通过 AsyncLocalStorage 绑定到
 * 当前 query，按 networkEpoch 校验后回传主进程，由诊断与恢复调度统一消费。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  classifyNetworkError,
  type NetworkFailureKind,
} from './network-errors'
import type { NetworkFetchScope } from './system-fetch'

export interface UtilityNetworkFailureNotice {
  epoch: number
  scope: NetworkFetchScope
  phase: 'headers' | 'stream'
  failure: NetworkFailureKind
}

export interface UtilityNetworkReporter {
  epoch: () => number
  /** 模型请求的路由代际；其他 scope 可返回 undefined。 */
  routeEpoch?: () => number | undefined
  report: (notice: UtilityNetworkFailureNotice) => void
}

const reporters = new AsyncLocalStorage<UtilityNetworkReporter>()

export function runWithUtilityNetworkReporter<T>(
  reporter: UtilityNetworkReporter,
  operation: () => T,
): T {
  return reporters.run(reporter, operation)
}

export function currentUtilityRouteEpochSource(): (() => number | undefined) | undefined {
  const reporter = reporters.getStore()
  const read = reporter?.routeEpoch
  return read ? () => read.call(reporter) : undefined
}

export function parseUtilityNetworkFailure(
  value: unknown,
  epoch: number,
): UtilityNetworkFailureNotice | undefined {
  if (!value || typeof value !== 'object') return undefined
  const payload = value as Record<string, unknown>
  if (
    payload.epoch !== epoch
    || !Number.isSafeInteger(payload.epoch)
    || epoch < 0
    || typeof payload.scope !== 'string'
    || typeof payload.phase !== 'string'
    || typeof payload.failure !== 'string'
    || !['cloud', 'model', 'mcp', 'oauth', 'download'].includes(payload.scope)
    || !['headers', 'stream'].includes(payload.phase)
    || !['proxy-unreachable', 'dns', 'tls', 'connect', 'timeout', 'stream-interrupted', 'cancelled', 'unknown'].includes(payload.failure)
  ) {
    return undefined
  }
  return {
    epoch,
    scope: payload.scope as NetworkFetchScope,
    phase: payload.phase as 'headers' | 'stream',
    failure: payload.failure as NetworkFailureKind,
  }
}

export function createUtilityFailureObserver(
  scope: NetworkFetchScope,
  signal: AbortSignal,
): ((error: unknown, phase: 'headers' | 'stream') => void) | undefined {
  const reporter = reporters.getStore()
  if (!reporter) return undefined
  const epoch = reporter.epoch()
  let reported = false
  return (error, phase) => {
    if (reported || signal.aborted) return
    let failure = classifyNetworkError(error)
    if (failure === 'cancelled') return
    if (phase === 'stream' && failure === 'unknown') failure = 'stream-interrupted'
    reported = true
    try {
      reporter.report({ scope, epoch, phase, failure })
    } catch {
      // 上报失败不能影响业务请求。
    }
  }
}
