import { describe, expect, test } from 'bun:test'
import type { CloudApiClient, CloudRequestInit } from '../types/api'
import { buildGoogleLoginUrl, createAuthApi, transformAuthResponse } from './auth'
import { createBillingApi } from './billing'
import { createApiKeysApi } from './api-keys'
import { createModelsApi } from './models'
import { createNotificationsApi } from './notifications'
import { createPromptsApi } from './prompts'
import { createSubscriptionApi } from './subscription'
import { buildQueryString, createUsageApi } from './usage'

interface StubCall {
  method: string
  path: string
  body?: unknown
}

function createStubClient(responses: Record<string, unknown> = {}): {
  client: CloudApiClient
  calls: StubCall[]
} {
  const calls: StubCall[] = []
  const resolveData = (path: string): unknown => responses[path]
  const respond = <T>(path: string, method: string, body?: unknown): Promise<{ data: T; status: number; ok: true }> => {
    calls.push({ method, path, body })
    return Promise.resolve({ data: resolveData(path) as T, status: 200, ok: true })
  }
  const client: CloudApiClient = {
    get: <T>(path: string, init?: CloudRequestInit) => respond<T>(path, init?.method ?? 'GET'),
    post: <T>(path: string, body?: unknown) => respond<T>(path, 'POST', body),
    put: <T>(path: string, body?: unknown) => respond<T>(path, 'PUT', body),
    patch: <T>(path: string, body?: unknown) => respond<T>(path, 'PATCH', body),
    del: <T>(path: string, init?: CloudRequestInit) => respond<T>(path, init?.method ?? 'DELETE'),
    refreshAuthToken: async () => 'token',
  }
  return { client, calls }
}

describe('Cloud 认证 API', () => {
  test('Given snake_case 登录响应 When 转换 Then 归一化 token 字段', () => {
    const session = transformAuthResponse({
      user: { id: 'u1', email: 'a@b.c', name: 'A', status: 'APPROVED' },
      access_token: 'tk',
      refresh_token: 'rt',
    })
    expect(session).toEqual({
      user: { id: 'u1', email: 'a@b.c', name: 'A', status: 'APPROVED' },
      token: 'tk',
      refreshToken: 'rt',
    })
  })

  test('Given 缺少 refresh_token When 转换 Then refreshToken 为 null', () => {
    const session = transformAuthResponse({
      user: { id: 'u1', email: 'a@b.c', name: 'A', status: 'PENDING' },
      access_token: 'tk',
    })
    expect(session.refreshToken).toBeNull()
  })

  test('Given 登录/注册/资料更新 When 调用 Then 命中正确方法与路径', async () => {
    const { client, calls } = createStubClient({
      '/auth/login': { user: { id: 'u', email: 'e', name: 'n', status: 'APPROVED' }, access_token: 't' },
      '/auth/register': { user: { id: 'u', email: 'e', name: 'n', status: 'PENDING' }, access_token: 't' },
      '/user/profile': { id: 'u', email: 'e', name: 'n', status: 'APPROVED' },
    })
    const api = createAuthApi(client)
    await api.login({ email: 'e', password: 'p' })
    await api.register({ email: 'e', password: 'p' })
    await api.updateProfile({ name: 'n' })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /auth/login',
      'POST /auth/register',
      'PATCH /user/profile',
    ])
    expect(calls[0]?.body).toEqual({ email: 'e', password: 'p' })
  })

  test('Given 验证码与密码流程 When 调用 Then 均 POST 对应路径', async () => {
    const { client, calls } = createStubClient()
    const api = createAuthApi(client)
    await api.verifyEmail({ email: 'e', code: '1' })
    await api.forgotPassword({ email: 'e' })
    await api.resetPassword({ token: 't', password: 'p' })
    await api.resendCode({ email: 'e' })
    expect(calls.map((call) => call.path)).toEqual([
      '/auth/verify-email',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/resend-code',
    ])
  })

  test('Given redirect_url When 构造 Google 登录地址 Then 正确编码', () => {
    expect(buildGoogleLoginUrl('https://api.proma.cool/api/v1', '/settings?tab=account'))
      .toBe('https://api.proma.cool/api/v1/auth/google?redirect_url=%2Fsettings%3Ftab%3Daccount')
    expect(buildGoogleLoginUrl('https://api.test', '/'))
      .toBe('https://api.test/auth/google?redirect_url=%2F')
  })
})

describe('Cloud 用量 API', () => {
  test('Given 各类参数 When 构造查询串 Then 与官方拼接一致', () => {
    expect(buildQueryString()).toBe('')
    expect(buildQueryString({})).toBe('')
    expect(buildQueryString({ dateFilter: '2026-01-02' })).toBe('?date_filter=2026-01-02')
    expect(buildQueryString({ page: 2, pageSize: 20 })).toBe('?page=2&page_size=20')
    expect(buildQueryString({ page: 0, pageSize: 0 })).toBe('')
  })

  test('Given 日志查询 When 调用 Then 命中对应路径', async () => {
    const { client, calls } = createStubClient()
    const api = createUsageApi(client)
    await api.getUsage({ page: 1 })
    await api.getCombinedUsage()
    await api.getToolUsage()
    await api.getSpeechUsage()
    await api.getAgentUsage()
    await api.getAgentTokenActivity({ startDate: '2026-01-01', endDate: '2026-01-02' })
    await api.getAgentTurnUsage('turn/1')
    expect(calls.map((call) => call.path)).toEqual([
      '/me/usage?page=1',
      '/me/combined-usage',
      '/me/tool-usage',
      '/me/speech-usage',
      '/me/agent-usage',
      '/me/agent-token-activity?start_date=2026-01-01&end_date=2026-01-02',
      '/me/agent-turn-usage/turn%2F1',
    ])
  })
})

describe('Cloud 订阅与账单 API', () => {
  test('Given 订阅流程 When 调用 Then 路径与 body 正确', async () => {
    const { client, calls } = createStubClient()
    const api = createSubscriptionApi(client)
    await api.getTiers()
    await api.getCurrent()
    await api.createWechatPayment('pro')
    await api.createAlipayPayment('pro')
    await api.getOrderStatus('order-1')
    await api.getHistory({ page: 2, page_size: 10 })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /subscription/tiers',
      'GET /subscription/current',
      'POST /subscription/wechat/create',
      'POST /subscription/alipay/create',
      'GET /subscription/orders/order-1',
      'GET /subscription/history?page=2&page_size=10',
    ])
    expect(calls[2]?.body).toEqual({ tier: 'pro' })
    expect(calls[3]?.body).toEqual({ tier: 'pro' })
  })

  test('Given 账单接口 When 调用 Then 命中用户路径', async () => {
    const { client, calls } = createStubClient()
    const api = createBillingApi(client)
    await api.getBilling()
    await api.checkBalance()
    expect(calls.map((call) => call.path)).toEqual(['/user/billing', '/user/check-balance'])
  })
})

describe('Cloud 模型/提示词/API Key API', () => {
  test('Given 模型与提示词 When 调用 Then 命中只读路径', async () => {
    const { client, calls } = createStubClient()
    await createModelsApi(client).getModels()
    await createPromptsApi(client).list()
    expect(calls).toEqual([
      { method: 'GET', path: '/models' },
      { method: 'GET', path: '/prompts' },
    ])
  })

  test('Given API Key 管理 When 调用 Then 方法与路径正确', async () => {
    const { client, calls } = createStubClient()
    const api = createApiKeysApi(client)
    await api.getSystemApiKey()
    await api.list()
    await api.create({ name: 'demo' })
    await api.update('k1', { name: 'renamed' })
    await api.delete('k1')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api-keys/system',
      'GET /api-keys',
      'POST /api-keys',
      'PATCH /api-keys/k1',
      'DELETE /api-keys/k1',
    ])
    expect(calls[3]?.body).toEqual({ name: 'renamed' })
  })
})

describe('Cloud 通知 API', () => {
  test('Given 包裹结构 When 获取 pending Then 过滤非法项', async () => {
    const { client, calls } = createStubClient({
      '/notifications/pending?platform=macos': {
        notifications: [
          {
            id: 'n1',
            title: '标题',
            bodyMarkdown: '内容',
            platform: 'macos',
            publishedAt: '2026-01-01T00:00:00Z',
          },
          { id: 'bad' },
        ],
      },
    })
    const notifications = await createNotificationsApi(client).listPending('macos')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.id).toBe('n1')
    expect(calls[0]?.path).toBe('/notifications/pending?platform=macos')
  })

  test('Given 通知 ID 含特殊字符 When 确认 Then 编码 ID 并保留 platform', async () => {
    const { client, calls } = createStubClient()
    await createNotificationsApi(client).acknowledge('a/b', 'windows')
    expect(calls[0]?.path).toBe('/notifications/a%2Fb/acknowledge?platform=windows')
  })
})
