/**
 * Cloud API 客户端
 *
 * 与官方 0.22.0 `packages/cloud/src/api/client.ts` 对齐：
 * - 自动附带 Bearer token
 * - 401 时单次 refresh + 重放（可重放 body）
 * - GET（system_key 以外）与 POST /auth/login 的有限重试
 * - 402 额度不足回调
 * - 会话版本号变化时取消在途请求
 * - 不包含真实登录态存储，TokenStorage 由主进程注入
 */

import type {
  CloudApiClient,
  CloudApiClientOptions,
  CloudApiResponse,
  CloudFetchRunner,
  CloudRequestInit,
  CloudTokenStorage,
} from '../types/api.ts'
import type { CloudRefreshTokenResponse } from '../types/user.ts'
import {
  assertCloudRequestActive,
  cancelledCloudRequest,
  createApiError,
  invalidCloudResponse,
  isApiError,
  withCloudDeadline,
  withCloudRequest,
  withDefaultCloudFetch,
} from './cloud-request.ts'
import { getCloudApiConfig } from '../config.ts'

interface RefreshFlight {
  revision: number
  promise: Promise<string>
}

/** 可重放请求体判定：流式 body 不能安全重放 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return !(body instanceof ReadableStream)
}

export function createApiClient(options: CloudApiClientOptions = {}): CloudApiClient {
  const config = getCloudApiConfig()
  const storage: CloudTokenStorage | undefined = options.tokenStorage
  const attemptTimeout = options.attemptTimeoutMs ?? config.timeout
  const operationTimeout = options.operationTimeoutMs ?? config.timeout * 2 + 1_000
  const withFetch: CloudFetchRunner = options.withFetch ?? withDefaultCloudFetch

  let refreshing: RefreshFlight | null = null

  const revision = (): number => storage?.getSessionRevision() ?? 0
  const assertSession = (expected: number): void => {
    if (revision() !== expected) throw cancelledCloudRequest()
  }

  function refreshAuthToken(): Promise<string> {
    const expected = revision()
    if (refreshing?.revision === expected) return refreshing.promise

    const promise = (async (): Promise<string> => {
      try {
        const refreshToken = storage?.getRefreshToken()
        if (!storage || !refreshToken) throw createApiError(401)

        const data = await withCloudDeadline(
          (signal) => withFetch((fetchFn) => withCloudRequest(
            `${config.baseUrl}/auth/refresh`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: refreshToken }),
              signal,
            },
            async (response): Promise<CloudRefreshTokenResponse> => {
              const body = await response.json() as unknown
              if (
                !body
                || typeof body !== 'object'
                || !('access_token' in body)
                || typeof body.access_token !== 'string'
                || !body.access_token.trim()
                || (
                  'refresh_token' in body
                  && body.refresh_token != null
                  && (typeof body.refresh_token !== 'string' || !body.refresh_token.trim())
                )
              ) {
                throw invalidCloudResponse()
              }
              return body as CloudRefreshTokenResponse
            },
            { timeoutMs: attemptTimeout, operation: 'refresh', fetchFn },
          )),
          operationTimeout,
        )

        assertSession(expected)
        storage.setToken(data.access_token)
        if (data.refresh_token) storage.setRefreshToken(data.refresh_token)
        return data.access_token
      } catch (error) {
        assertSession(expected)
        if (isApiError(error) && error.kind === 'auth' && storage) {
          storage.clearTokens()
          options.onAuthFailed?.()
        }
        throw error
      }
    })()

    const flight: RefreshFlight = { revision: expected, promise }
    refreshing = flight
    const clear = (): void => {
      if (refreshing === flight) refreshing = null
    }
    void promise.then(clear, clear)
    return promise
  }

  async function request<T>(
    path: string,
    init: CloudRequestInit,
  ): Promise<CloudApiResponse<T>> {
    const expected = revision()
    const isPublicAuth = path === '/auth/login' || path === '/auth/register'
    const operation = path === '/auth/login'
      ? 'login'
      : path === '/api-keys/system'
        ? 'system_key'
        : 'cloud'

    return withCloudDeadline(async (signal): Promise<CloudApiResponse<T>> => {
      let retried = false
      let refreshed = false
      let attempt = 0

      while (true) {
        assertCloudRequestActive(signal)
        assertSession(expected)

        const token = storage?.getToken()
        const headers = new Headers(init.headers)
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
        if (token) headers.set('Authorization', `Bearer ${token}`)

        try {
          const result = await withFetch((fetchFn) => withCloudRequest(
            `${config.baseUrl}${path}`,
            { ...init, headers, signal },
            async (response): Promise<CloudApiResponse<T>> => ({
              data: (response.status === 204 ? undefined : await response.json()) as T,
              status: response.status,
              ok: true,
            }),
            { timeoutMs: attemptTimeout, operation, attempt: attempt++, fetchFn },
          ))
          assertCloudRequestActive(signal)
          assertSession(expected)
          return result
        } catch (error) {
          assertCloudRequestActive(signal)
          assertSession(expected)
          if (!isApiError(error)) throw error
          if (error.status === 401 && isPublicAuth) {
            throw createApiError(401, 'auth', '邮箱或密码错误')
          }

          const replayableBody = isReplayableBody(init.body)
          if (
            error.status === 401
            && storage
            && !refreshed
            && !isPublicAuth
            && path !== '/auth/refresh'
            && replayableBody
          ) {
            refreshed = true
            if (storage.getToken() === token) {
              await refreshAuthToken()
            }
            continue
          }

          if (error.status === 402) options.onQuotaExceeded?.()

          const canRetry = (
            !retried
            && error.retryable
            && replayableBody
            && (
              (init.method === 'GET' && operation !== 'system_key')
              || (init.method === 'POST' && path === '/auth/login')
            )
          )
          if (canRetry) {
            retried = true
            await waitBeforeRetry(options.retryDelayMs ?? 250 + Math.floor(Math.random() * 251), signal)
            continue
          }

          throw error
        }
      }
    }, operationTimeout, init.signal ?? undefined)
  }

  const mutation = <T>(
    method: string,
    path: string,
    body: unknown,
    init?: CloudRequestInit,
  ): Promise<CloudApiResponse<T>> => request<T>(path, {
    ...init,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  return {
    get: <T>(path: string, init?: CloudRequestInit) => request<T>(path, { ...init, method: 'GET' }),
    post: <T>(path: string, body?: unknown, init?: CloudRequestInit) => mutation<T>('POST', path, body, init),
    put: <T>(path: string, body?: unknown, init?: CloudRequestInit) => mutation<T>('PUT', path, body, init),
    patch: <T>(path: string, body?: unknown, init?: CloudRequestInit) => mutation<T>('PATCH', path, body, init),
    del: <T>(path: string, init?: CloudRequestInit) => request<T>(path, { ...init, method: 'DELETE' }),
    refreshAuthToken,
  }
}

/** 重试前等待；父级取消时立即抛取消错误 */
function waitBeforeRetry(delay: number, signal: AbortSignal): Promise<void> {
  assertCloudRequestActive(signal)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(cancelledCloudRequest())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delay)
    signal.addEventListener('abort', abort, { once: true })
  })
}
