import { describe, expect, test } from 'bun:test'
import { createApiClient } from './client'
import type { CloudFetch, CloudRequestInit, CloudTokenStorage } from '../types/api'

interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

class MemoryTokenStorage implements CloudTokenStorage {
  token: string | null = null
  refreshToken: string | null = null
  revision = 0
  cleared = 0

  constructor(init: { token?: string | null; refreshToken?: string | null } = {}) {
    this.token = init.token ?? null
    this.refreshToken = init.refreshToken ?? null
  }

  getToken(): string | null {
    return this.token
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  setToken(token: string): void {
    this.token = token
  }

  setRefreshToken(token: string | null): void {
    this.refreshToken = token
  }

  clearTokens(): void {
    this.token = null
    this.refreshToken = null
    this.cleared += 1
  }

  getSessionRevision(): number {
    return this.revision
  }
}

type FetchHandler = (call: RecordedCall) => Response | Promise<Response>

function createHarness(handler: FetchHandler): {
  calls: RecordedCall[]
  withFetch: <T>(work: (fetchFn: CloudFetch) => Promise<T>) => Promise<T>
} {
  const calls: RecordedCall[] = []
  const fakeFetch: CloudFetch = async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    }
    calls.push(call)
    return handler(call)
  }
  return {
    calls,
    withFetch: async (work) => work(fakeFetch),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createClient(handler: FetchHandler, storage?: MemoryTokenStorage, extra: {
  onAuthFailed?: () => void
  onQuotaExceeded?: () => void
} = {}) {
  const harness = createHarness(handler)
  const client = createApiClient({
    tokenStorage: storage,
    withFetch: harness.withFetch,
    retryDelayMs: 0,
    attemptTimeoutMs: 1_000,
    operationTimeoutMs: 2_000,
    onAuthFailed: extra.onAuthFailed,
    onQuotaExceeded: extra.onQuotaExceeded,
  })
  return { client, calls: harness.calls }
}

describe('Cloud API 客户端：认证头与响应', () => {
  test('Given 未登录 When GET Then 不带 Authorization 但仍发请求', async () => {
    const { client, calls } = createClient(() => jsonResponse({ ok: true }))
    const result = await client.get<{ ok: boolean }>('/health')
    expect(result).toEqual({ data: { ok: true }, status: 200, ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.proma.cool/api/v1/health')
    expect(calls[0]?.headers.has('Authorization')).toBe(false)
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json')
  })

  test('Given 已登录 When GET Then 附带 Bearer token', async () => {
    const storage = new MemoryTokenStorage({ token: 't1' })
    const { client, calls } = createClient(() => jsonResponse({ ok: true }), storage)
    await client.get('/auth/me')
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer t1')
  })

  test('Given POST body When 发送 Then 序列化为 JSON', async () => {
    const { client, calls } = createClient(() => jsonResponse({ created: true }))
    await client.post('/api-keys', { name: 'demo', quotaLimit: 10 })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ name: 'demo', quotaLimit: 10 })
  })

  test('Given 204 When GET Then data 为 undefined', async () => {
    const { client } = createClient(() => new Response(null, { status: 204 }))
    const result = await client.del<undefined>('/api-keys/1')
    expect(result.status).toBe(204)
    expect(result.data).toBeUndefined()
  })
})

describe('Cloud API 客户端：401 刷新', () => {
  test('Given access token 过期 When 请求 Then 刷新后重放并更新存储', async () => {
    const storage = new MemoryTokenStorage({ token: 'old', refreshToken: 'r1' })
    let meCalls = 0
    const { client, calls } = createClient((call) => {
      if (call.url.endsWith('/auth/me')) {
        meCalls += 1
        if (meCalls === 1) return jsonResponse({}, 401)
        return jsonResponse({ id: 'u1', email: 'a@b.c', name: 'A', status: 'APPROVED' })
      }
      if (call.url.endsWith('/auth/refresh')) {
        return jsonResponse({ access_token: 'new', refresh_token: 'r2' })
      }
      throw new Error(`unexpected ${call.url}`)
    }, storage)

    const result = await client.get<{ id: string }>('/auth/me')
    expect(result.data.id).toBe('u1')
    expect(storage.token).toBe('new')
    expect(storage.refreshToken).toBe('r2')
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.proma.cool/api/v1/auth/me',
      'https://api.proma.cool/api/v1/auth/refresh',
      'https://api.proma.cool/api/v1/auth/me',
    ])
    expect(calls[1]?.headers.has('Authorization')).toBe(false)
    expect(calls[2]?.headers.get('Authorization')).toBe('Bearer new')
  })

  test('Given 登录接口 401 When 登录 Then 直接返回邮箱或密码错误，不刷新', async () => {
    const storage = new MemoryTokenStorage({ token: 't1', refreshToken: 'r1' })
    const { client, calls } = createClient(() => jsonResponse({}, 401), storage)
    await expect(client.post('/auth/login', { email: 'a', password: 'b' }))
      .rejects.toMatchObject({ status: 401, kind: 'auth', message: '邮箱或密码错误' })
    expect(calls).toHaveLength(1)
  })

  test('Given 无 token 存储 When 请求 401 Then 不尝试刷新', async () => {
    const { client, calls } = createClient(() => jsonResponse({}, 401))
    await expect(client.get('/auth/me')).rejects.toMatchObject({ status: 401, kind: 'auth' })
    expect(calls).toHaveLength(1)
  })

  test('Given 无 refresh token When 刷新 Then 清空登录态并回调', async () => {
    const storage = new MemoryTokenStorage({ token: 'old', refreshToken: null })
    let authFailed = 0
    const { client } = createClient(() => jsonResponse({}, 401), storage, {
      onAuthFailed: () => { authFailed += 1 },
    })
    await expect(client.get('/auth/me')).rejects.toMatchObject({ status: 401 })
    expect(storage.cleared).toBe(1)
    expect(authFailed).toBe(1)
  })

  test('Given 刷新接口 401 When 刷新 Then 清空登录态并拒绝', async () => {
    const storage = new MemoryTokenStorage({ token: 'old', refreshToken: 'r1' })
    let authFailed = 0
    const { client } = createClient((call) => (
      call.url.endsWith('/auth/refresh') ? jsonResponse({}, 401) : jsonResponse({}, 401)
    ), storage, { onAuthFailed: () => { authFailed += 1 } })

    await expect(client.get('/auth/me')).rejects.toMatchObject({ status: 401, kind: 'auth' })
    expect(storage.cleared).toBe(1)
    expect(authFailed).toBe(1)
  })

  test('Given 并发刷新 When 调用 refreshAuthToken Then 只发一次请求', async () => {
    const storage = new MemoryTokenStorage({ token: 'old', refreshToken: 'r1' })
    let refreshCalls = 0
    let releaseRefresh: ((response: Response) => void) | undefined
    const { client } = createClient(() => {
      refreshCalls += 1
      return new Promise<Response>((resolve) => { releaseRefresh = resolve })
    }, storage)

    const first = client.refreshAuthToken()
    const second = client.refreshAuthToken()
    await Promise.resolve()
    await Promise.resolve()
    expect(refreshCalls).toBe(1)
    releaseRefresh?.(jsonResponse({ access_token: 'new' }))
    await expect(Promise.all([first, second])).resolves.toEqual(['new', 'new'])
    expect(storage.token).toBe('new')
  })

  test('Given 未登录 When 主动刷新 Then 抛 auth 错误', async () => {
    const { client, calls } = createClient(() => jsonResponse({}))
    await expect(client.refreshAuthToken()).rejects.toMatchObject({ status: 401, kind: 'auth' })
    expect(calls).toHaveLength(0)
  })
})

describe('Cloud API 客户端：额度与重试', () => {
  test('Given 402 When 请求 Then 触发额度回调并抛出', async () => {
    let quotaExceeded = 0
    const { client } = createClient(() => jsonResponse({}, 402), undefined, {
      onQuotaExceeded: () => { quotaExceeded += 1 },
    })
    await expect(client.get('/me/usage')).rejects.toMatchObject({ status: 402 })
    expect(quotaExceeded).toBe(1)
  })

  test('Given GET 500 后恢复 When 请求 Then 自动重试一次', async () => {
    let count = 0
    const { client, calls } = createClient(() => {
      count += 1
      return count === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true })
    })
    const result = await client.get<{ ok: boolean }>('/me/usage')
    expect(result.data.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('Given 普通 POST 500 When 请求 Then 不重试', async () => {
    const { client, calls } = createClient(() => jsonResponse({}, 500))
    await expect(client.post('/api-keys', { name: 'x' })).rejects.toMatchObject({ status: 500 })
    expect(calls).toHaveLength(1)
  })

  test('Given 登录 POST 500 后恢复 When 登录 Then 重试一次', async () => {
    let count = 0
    const { client, calls } = createClient(() => {
      count += 1
      return count === 1
        ? jsonResponse({}, 500)
        : jsonResponse({ user: { id: 'u', email: 'e', name: 'n', status: 'APPROVED' }, access_token: 'tk' })
    })
    const result = await client.post<{ access_token: string }>('/auth/login', { email: 'a', password: 'b' })
    expect(result.data.access_token).toBe('tk')
    expect(calls).toHaveLength(2)
  })

  test('Given system key 接口 500 When 请求 Then 不重试（避免 key 轮换风暴）', async () => {
    const storage = new MemoryTokenStorage({ token: 't1' })
    const { client, calls } = createClient(() => jsonResponse({}, 500), storage)
    await expect(client.get('/api-keys/system')).rejects.toMatchObject({ status: 500 })
    expect(calls).toHaveLength(1)
  })

  test('Given 会话版本变化 When 请求返回 Then 抛取消错误', async () => {
    const storage = new MemoryTokenStorage({ token: 't1' })
    const { client } = createClient(() => {
      storage.revision += 1
      return jsonResponse({ ok: true })
    }, storage)
    await expect(client.get('/auth/me')).rejects.toMatchObject({
      kind: 'unknown',
      message: '请求已取消，请重试',
    })
  })
})

describe('Cloud API 客户端：请求头覆盖', () => {
  test('Given 自定义 Content-Type When 请求 Then 不覆盖调用方值', async () => {
    const { client, calls } = createClient(() => jsonResponse({}))
    const init: CloudRequestInit = { headers: { 'Content-Type': 'text/plain' } }
    await client.get('/custom', init)
    expect(calls[0]?.headers.get('Content-Type')).toBe('text/plain')
  })
})
