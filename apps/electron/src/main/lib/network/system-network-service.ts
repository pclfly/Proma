/**
 * 系统网络策略服务。
 *
 * 官方 0.22.0：Electron 5 个网络作用域统一走系统代理。策略初始化后
 * `ensureReady()` 才放行请求；恢复流程强制刷新代理配置并清理 DNS 缓存，
 * 成功后递增 `networkEpoch`，让长连接与浏览器会话重新绑定路由。
 */

import {
  NetworkRequestError,
  classifyNetworkError,
  safeNetworkErrorCode,
} from './network-errors'

export const SYSTEM_NETWORK_SCOPES = ['cloud', 'model', 'mcp', 'oauth', 'download'] as const
export type SystemNetworkScope = (typeof SYSTEM_NETWORK_SCOPES)[number]
export type SystemNetworkStatus = 'recovering' | 'ready' | 'unreachable'

export interface SystemNetworkSnapshot {
  policy: 'system'
  networkEpoch: number
  status: SystemNetworkStatus
}

/** 系统网络 fetch 只要求标准两参签名，不依赖 Bun 的 preconnect 扩展。 */
export type SystemNetworkFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface SystemNetworkSession {
  setProxy: (config: { mode: 'system' }) => Promise<void>
  forceReloadProxyConfig: () => Promise<void>
  clearHostResolverCache?: () => Promise<void>
  fetch: SystemNetworkFetch
}

export interface SystemNetworkDependencies {
  configureUtility: () => Promise<void>
  createSession: (scope: SystemNetworkScope) => SystemNetworkSession
  onChange?: (snapshot: SystemNetworkSnapshot) => void
  onTransportFailure?: (error: unknown) => void
  clearDefaultHostCache?: () => Promise<void>
  policyTimeoutMs?: number
}

export interface SystemNetworkService {
  snapshot: () => SystemNetworkSnapshot
  subscribe: (listener: (snapshot: SystemNetworkSnapshot) => void) => () => void
  initialize: () => Promise<void>
  ensureReady: (signal?: AbortSignal) => Promise<void>
  getFetch: (scope: SystemNetworkScope) => SystemNetworkFetch
  recover: (reason: string) => Promise<SystemNetworkSnapshot>
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NetworkRequestError('timeout', 'system')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throw new DOMException('请求已取消', 'AbortError')
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new DOMException('请求已取消', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

export function createSystemNetworkService(
  dependencies: SystemNetworkDependencies,
): SystemNetworkService {
  const listeners = new Set<(snapshot: SystemNetworkSnapshot) => void>()
  const sessions = new Map<SystemNetworkScope, SystemNetworkSession>()
  const transports = new Map<SystemNetworkScope, SystemNetworkFetch>()
  let status: SystemNetworkStatus = 'recovering'
  let networkEpoch = 0
  let configured = false
  let initializing: Promise<void> | undefined
  let recovering: Promise<SystemNetworkSnapshot> | undefined

  const snapshot = (): SystemNetworkSnapshot => ({ policy: 'system', networkEpoch, status })

  const publish = (): void => {
    const value = snapshot()
    dependencies.onChange?.(value)
    for (const listener of listeners) {
      try {
        listener(value)
      } catch {
        // 订阅者异常不能打断网络状态广播。
      }
    }
  }

  const configure = async (): Promise<void> => {
    await dependencies.configureUtility()
    await Promise.all(SYSTEM_NETWORK_SCOPES.map(async (scope) => {
      let target = sessions.get(scope)
      if (!target) {
        target = dependencies.createSession(scope)
        sessions.set(scope, target)
      }
      await target.setProxy({ mode: 'system' })
    }))
  }

  const initialize = async (): Promise<void> => {
    if (configured) return
    if (!initializing) {
      initializing = (async () => {
        try {
          await bounded(configure(), dependencies.policyTimeoutMs ?? 5_000)
          configured = true
          status = 'ready'
          publish()
        } catch (error) {
          status = 'unreachable'
          publish()
          throw new NetworkRequestError(
            classifyNetworkError(error),
            'system',
            safeNetworkErrorCode(error),
          )
        }
      })().finally(() => {
        initializing = undefined
      })
    }
    return initializing
  }

  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    initialize,
    async ensureReady(signal) {
      await cancellable(initialize(), signal)
      if (!configured) throw new NetworkRequestError('connect', 'system')
    },
    getFetch(scope) {
      const cached = transports.get(scope)
      if (cached) return cached
      const transport: SystemNetworkFetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        )
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw new NetworkRequestError('unknown', scope)
        }
        const signal = init?.signal
          ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined)
        if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
        await cancellable(initialize(), signal)
        const target = sessions.get(scope)
        if (!configured || !target) throw new NetworkRequestError('connect', scope)
        try {
          return await target.fetch(input, { ...init, credentials: 'omit' })
        } catch (error) {
          if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
          dependencies.onTransportFailure?.(error)
          throw new NetworkRequestError(
            classifyNetworkError(error),
            scope,
            safeNetworkErrorCode(error),
          )
        }
      }
      transports.set(scope, transport)
      return transport
    },
    async recover(_reason) {
      if (!recovering) {
        recovering = (async () => {
          await initialize()
          status = 'recovering'
          publish()
          try {
            await bounded((async () => {
              await dependencies.configureUtility()
              await Promise.all(
                [...sessions.values()].map((target) => target.forceReloadProxyConfig()),
              )
              await Promise.all([
                ...[...sessions.values()].map((target) => target.clearHostResolverCache?.()),
                dependencies.clearDefaultHostCache?.(),
              ])
            })(), dependencies.policyTimeoutMs ?? 5_000)
            networkEpoch += 1
            status = 'ready'
            publish()
            return snapshot()
          } catch (error) {
            status = 'unreachable'
            publish()
            throw new NetworkRequestError(
              classifyNetworkError(error),
              'system',
              safeNetworkErrorCode(error),
            )
          }
        })().finally(() => {
          recovering = undefined
        })
      }
      return recovering
    },
  }
}
