/**
 * Chromium 系统网络 fetch。
 *
 * 官方 0.22.0：
 * - 只允许 http/https，拒绝 URL 内嵌凭据；
 * - 带自定义凭据头、敏感 query 或非 GET/HEAD 的请求禁止跟随重定向；
 * - 路由 epoch 变化后，长时间无新数据由 stall watchdog 主动中断；
 * - 包装响应流，保证中断时能取消底层 reader 并向上游报错。
 */

import { NetworkRequestError, classifyNetworkError } from './network-errors'
import { RouteStallError, createStallWatchdog } from './stall-watchdog'
import type { SystemNetworkFetch } from './system-network-service'

export type { SystemNetworkFetch }

export type NetworkFetchScope = 'cloud' | 'model' | 'mcp' | 'oauth' | 'download'

export interface ChromiumFetchObserver {
  (error: unknown, phase: 'headers' | 'stream'): void
}

export interface ChromiumFetchOptions {
  routeEpochSource?: () => number | undefined
  stallMs?: number
  tickMs?: number
}

export interface ChromiumFetchDependencies {
  fetcher: SystemNetworkFetch
  createObserver?: (signal: AbortSignal) => ChromiumFetchObserver | undefined
  options?: ChromiumFetchOptions
}

const PUBLIC_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'cache-control',
  'pragma',
  'range',
  'if-none-match',
  'if-modified-since',
])

const SENSITIVE_QUERY = /^(?:key|api[_-]?key|access_token|token|signature|x-amz-signature|x-goog-signature)$/i

export function createChromiumFetch(
  fetcher: SystemNetworkFetch,
  createObserver?: (signal: AbortSignal) => ChromiumFetchObserver | undefined,
  options: ChromiumFetchOptions = {},
): SystemNetworkFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new NetworkRequestError('unknown')
    }

    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
    )
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase()
    const sensitiveQuery = [...url.searchParams.keys()].some((name) => SENSITIVE_QUERY.test(name))
    const credentialed = [...headers.keys()].some((name) => !PUBLIC_HEADERS.has(name.toLowerCase()))

    const owner = new AbortController()
    const caller = init?.signal === null
      ? undefined
      : init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = caller ? AbortSignal.any([caller, owner.signal]) : owner.signal

    let observer: ChromiumFetchObserver | undefined
    try {
      observer = createObserver?.(signal)
    } catch {
      // 观察器创建失败不能影响请求本身。
    }
    const observe = (error: unknown, phase: 'headers' | 'stream'): void => {
      try {
        observer?.(error, phase)
      } catch {
        // 观察器异常不能改变请求结果。
      }
    }

    signal.throwIfAborted()

    let stalled = false
    let onHeadersStall: ((error: unknown) => void) | undefined
    let onStreamStall: ((error: unknown) => void) | undefined
    let watchdog: ReturnType<typeof createStallWatchdog> | undefined
    let routeEpoch: number | undefined
    try {
      routeEpoch = options.routeEpochSource?.()
    } catch {
      routeEpoch = undefined
    }

    if (routeEpoch) {
      watchdog = createStallWatchdog({
        routeEpoch: () => routeEpoch,
        stallMs: options.stallMs,
        tickMs: options.tickMs,
        onStall: () => {
          if (caller?.aborted) return
          stalled = true
          const error = new RouteStallError()
          onHeadersStall?.(error)
          onStreamStall?.(error)
          owner.abort()
        },
      })
      signal.addEventListener('abort', () => watchdog?.stop(), { once: true })
    }

    const requestInit: RequestInit & { bypassCustomProtocolHandlers?: boolean } = {
      ...init,
      ...(credentialed || sensitiveQuery || !['GET', 'HEAD'].includes(method)) && { redirect: 'error' as const },
      credentials: 'omit',
      signal,
      bypassCustomProtocolHandlers: true,
    }
    const pending = fetcher(input instanceof URL ? input.href : input, requestInit)

    let response: Response
    try {
      response = watchdog
        ? await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              onHeadersStall = reject
            }),
          ])
        : await pending
    } catch (error) {
      watchdog?.stop()
      const failure = stalled ? new RouteStallError() : error
      if (stalled) {
        pending.then(
          (late) => late.body?.cancel().catch(() => undefined),
          () => undefined,
        )
      }
      observe(failure, 'headers')
      owner.abort()
      throw failure
    } finally {
      onHeadersStall = undefined
    }

    watchdog?.progress()
    if (signal.aborted) {
      watchdog?.stop()
      owner.abort()
      await response.body?.cancel().catch(() => undefined)
      if (stalled) throw new RouteStallError()
      signal.throwIfAborted()
    }

    if (!response.body) {
      watchdog?.stop()
      return response
    }

    const reader = response.body.getReader()
    const observeStream = response.ok ? observe : undefined
    let released = false
    let cancelled = false
    let failed = false
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined

    const release = (): void => {
      if (!released) {
        released = true
        watchdog?.stop()
        reader.releaseLock()
      }
    }

    onStreamStall = (error) => {
      if (cancelled || failed || released) return
      failed = true
      observeStream?.(error, 'stream')
      try {
        streamController?.error(error)
      } catch {
        // controller 已关闭时忽略。
      }
      void reader.cancel(error).catch(() => undefined).finally(release)
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      async pull(controller) {
        try {
          const result = await reader.read()
          if (cancelled || failed) return
          if (result.done) {
            release()
            controller.close()
          } else {
            watchdog?.progress()
            controller.enqueue(result.value)
          }
        } catch (error) {
          if (failed) return
          failed = true
          if (!cancelled) observeStream?.(error, 'stream')
          owner.abort()
          release()
          if (!cancelled) controller.error(error)
        }
      },
      async cancel(reason) {
        cancelled = true
        watchdog?.stop()
        owner.abort()
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      },
    }, { highWaterMark: 0 })

    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    })
    return wrapped
  }
}

/**
 * Utility 进程可用的 Chromium fetch。
 *
 * Utility 进程拿不到主进程的 session，只能使用 Electron `net.fetch`；
 * 仍复用同一套协议/重定向/流包装规则。
 */
export function createUtilitySystemFetch(
  scope: NetworkFetchScope,
  fetcher: SystemNetworkFetch,
  routeEpochSource?: () => number | undefined,
  createObserver?: (signal: AbortSignal) => ((error: unknown, phase: 'headers' | 'stream') => void) | undefined,
): SystemNetworkFetch {
  return createChromiumFetch(
    fetcher,
    createObserver,
    scope === 'model' && routeEpochSource ? { routeEpochSource } : {},
  )
}

/** 观察归一化错误；供需要诊断上报的调用方复用。 */
export function describeSystemNetworkFailure(error: unknown): {
  failure: ReturnType<typeof classifyNetworkError>
  errorCode?: string
} {
  return {
    failure: classifyNetworkError(error),
    ...(error instanceof NetworkRequestError && error.causeCode
      ? { errorCode: error.causeCode }
      : {}),
  }
}
