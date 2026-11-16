import { describe, expect, test } from 'bun:test'
import {
  SAFE_CAUSE_CODES,
  assertCloudRequestActive,
  cancelledCloudRequest,
  createApiError,
  getSafeCloudFailureMessage,
  invalidCloudResponse,
  isApiError,
  safeCauseCode,
  withCloudDeadline,
  withCloudRequest,
} from './cloud-request'
import type { CloudApiError, CloudFetch } from '../types/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Cloud 错误归一化', () => {
  test('Given 0 When 创建错误 Then 归类为 network 且可重试', () => {
    const error = createApiError(0)
    expect(error.kind).toBe('network')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('未能连接 Proma Cloud')
  })

  test('Given 各 HTTP 状态 When 创建错误 Then 映射为稳定 kind', () => {
    const cases: Array<[number, CloudApiError['kind']]> = [
      [401, 'auth'],
      [408, 'timeout'],
      [429, 'rate_limited'],
      [500, 'server'],
      [502, 'server'],
      [400, 'client'],
      [402, 'client'],
      [304, 'unknown'],
      [200, 'unknown'],
    ]
    for (const [status, kind] of cases) {
      expect(createApiError(status).kind).toBe(kind)
    }
  })

  test('Given 可重试 kind When 创建错误 Then retryable 为 true，其余为 false', () => {
    expect(createApiError(500).retryable).toBe(true)
    expect(createApiError(408).retryable).toBe(true)
    expect(createApiError(429).retryable).toBe(true)
    expect(createApiError(401).retryable).toBe(false)
    expect(createApiError(400).retryable).toBe(false)
  })

  test('Given 显式 kind/message When 创建错误 Then 原样保留', () => {
    const error = createApiError(401, 'auth', '邮箱或密码错误')
    expect(error).toEqual({
      status: 401,
      kind: 'auth',
      retryable: false,
      message: '邮箱或密码错误',
    })
  })

  test('Given 每种 kind When 取安全文案 Then 均不包含 token 占位', () => {
    const kinds: CloudApiError['kind'][] = [
      'network',
      'timeout',
      'server',
      'rate_limited',
      'auth',
      'client',
      'unknown',
    ]
    for (const kind of kinds) {
      const message = getSafeCloudFailureMessage(kind)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('Bearer')
      expect(message).not.toContain('token')
    }
    expect(getSafeCloudFailureMessage('auth')).toBe('认证已过期，请重新登录')
  })

  test('Given 取消与无效响应 When 构造 Then 使用专属文案', () => {
    expect(cancelledCloudRequest().message).toBe('请求已取消，请重试')
    expect(invalidCloudResponse().message).toContain('无效响应')
  })

  test('Given 合法结构 When isApiError Then 判定为真；缺字段/非法 kind 为假', () => {
    expect(isApiError(createApiError(500))).toBe(true)
    expect(isApiError({ status: 500, kind: 'server', retryable: true, message: 'x' })).toBe(true)
    expect(isApiError(null)).toBe(false)
    expect(isApiError({ status: 500 })).toBe(false)
    expect(isApiError({ status: 500, kind: 'bogus', retryable: true, message: 'x' })).toBe(false)
    expect(isApiError({ status: '500', kind: 'server', retryable: true, message: 'x' })).toBe(false)
  })

  test('Given 白名单错误码 When 提取 causeCode Then 只返回安全 code', () => {
    expect(safeCauseCode({ cause: { code: 'ECONNRESET' } })).toBe('ECONNRESET')
    expect(safeCauseCode({ code: 'ENOTFOUND' })).toBe('ENOTFOUND')
    expect(safeCauseCode({ cause: { code: 'SOMETHING_PRIVATE' } })).toBeUndefined()
    expect(safeCauseCode({ cause: { message: 'no code' } })).toBeUndefined()
    expect(safeCauseCode('boom')).toBeUndefined()
    expect(SAFE_CAUSE_CODES.has('UND_ERR_BODY_TIMEOUT')).toBe(true)
  })
})

describe('Cloud 请求超时与取消', () => {
  test('Given 父级 signal 已取消 When 执行 Then 立即抛取消错误', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withCloudDeadline(async () => 'never', 1_000, controller.signal))
      .rejects.toMatchObject({ kind: 'unknown', message: '请求已取消，请重试' })
  })

  test('Given 工作超时 When 执行 Then 抛 timeout 错误', async () => {
    await expect(withCloudDeadline(() => new Promise(() => {}), 10))
      .rejects.toMatchObject({ kind: 'timeout', status: 0 })
  })

  test('Given 父级中途取消 When 执行 Then 抛取消错误', async () => {
    const controller = new AbortController()
    const promise = withCloudDeadline(() => new Promise(() => {}), 5_000, controller.signal)
    setTimeout(() => controller.abort(), 5)
    await expect(promise).rejects.toMatchObject({ message: '请求已取消，请重试' })
  })

  test('Given 正常完成 When 执行 Then 返回结果且清理监听', async () => {
    const controller = new AbortController()
    await expect(withCloudDeadline(async () => 42, 1_000, controller.signal)).resolves.toBe(42)
    expect(controller.signal.aborted).toBe(false)
  })
})

describe('Cloud 请求执行器', () => {
  test('Given 200 且合法 JSON When 请求 Then 交给 read 解析', async () => {
    const fetchFn: CloudFetch = async () => jsonResponse({ ok: true })
    const data = await withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )
    expect(data).toEqual({ ok: true })
  })

  test('Given 401 When 请求 Then 抛 auth 错误', async () => {
    const fetchFn: CloudFetch = async () => jsonResponse({}, 401)
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ status: 401, kind: 'auth', retryable: false })
  })

  test('Given 500 When 请求 Then 抛 server 错误且可重试', async () => {
    const fetchFn: CloudFetch = async () => jsonResponse({}, 503)
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ status: 503, kind: 'server', retryable: true })
  })

  test('Given 304 When 允许未修改 Then 仍交给 read 处理', async () => {
    const fetchFn: CloudFetch = async () => new Response(null, { status: 304 })
    const data = await withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.status,
      { timeoutMs: 1_000, operation: 'catalog', allowNotModified: true, fetchFn },
    )
    expect(data).toBe(304)
  })

  test('Given 304 但未允许 Then 抛 unknown 错误', async () => {
    const fetchFn: CloudFetch = async () => new Response(null, { status: 304 })
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ status: 304, kind: 'unknown' })
  })

  test('Given 200 但响应体不是 JSON When 请求 Then 抛无效响应', async () => {
    const fetchFn: CloudFetch = async () => new Response('not json', { status: 200 })
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ kind: 'unknown', message: 'Proma Cloud 返回了无效响应，请稍后重试' })
  })

  test('Given fetch 抛网络错误 When 请求 Then 归类 network', async () => {
    const fetchFn: CloudFetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ status: 0, kind: 'network', retryable: true })
  })

  test('Given signal 已取消 When 执行 Then 抛取消错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn: CloudFetch = async () => jsonResponse({})
    await expect(withCloudRequest(
      'https://api.test/x',
      { method: 'GET', signal: controller.signal },
      async (response) => response.json(),
      { timeoutMs: 1_000, operation: 'test', fetchFn },
    )).rejects.toMatchObject({ message: '请求已取消，请重试' })
  })
})

describe('Cloud 请求活跃判定', () => {
  test('Given 已取消 signal When 断言活跃 Then 抛取消错误', () => {
    const controller = new AbortController()
    expect(() => assertCloudRequestActive(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => assertCloudRequestActive(controller.signal)).toThrow('请求已取消，请重试')
  })
})
