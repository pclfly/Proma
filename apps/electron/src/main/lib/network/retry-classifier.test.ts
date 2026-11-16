import { describe, expect, test } from 'bun:test'
import { classifyModelFailure, describeModelFailure, isRetryableNetworkFailure } from './retry-classifier'

describe('模型失败分类器', () => {
  test('Given 429 限流 When 分类 Then 识别限流并保留 Pi 的可重试判断', () => {
    // 分类器只负责识别原因；是否重试由 Pi 的原始判断作为 piRetryable 传入。
    expect(classifyModelFailure('429 Too Many Requests')).toMatchObject({
      retryable: false,
      reasonKind: 'rate_limited',
      safeCode: 'HTTP 429',
    })
    expect(classifyModelFailure('429 Too Many Requests', true)).toMatchObject({
      retryable: true,
      reasonKind: 'rate_limited',
      safeCode: 'HTTP 429',
    })
  })

  test('Given 账单类 429 When 分类 Then 不可重试', () => {
    for (const message of [
      '429 insufficient_quota: billing limit reached',
      '429: You exceeded your current quota exceeded for this month',
      '积分不足，无法继续请求',
    ]) {
      expect(classifyModelFailure(message).retryable).toBe(false)
    }
  })

  test('Given 普通 4xx When 分类 Then 不可重试', () => {
    for (const message of ['400 Bad Request', '401 Unauthorized', '404 Not Found']) {
      expect(classifyModelFailure(message).retryable).toBe(false)
    }
  })

  test('Given Chromium 网络错误码 When 分类 Then 按可恢复性区分 detail', () => {
    expect(classifyModelFailure('ERR_NAME_NOT_RESOLVED')).toMatchObject({
      retryable: true,
      reasonKind: 'connection',
      detail: 'dns',
    })
    expect(classifyModelFailure('ERR_INTERNET_DISCONNECTED')).toMatchObject({
      retryable: true,
      reasonKind: 'connection',
      detail: 'offline',
    })
    expect(classifyModelFailure('ERR_CERT_AUTHORITY_INVALID')).toMatchObject({
      retryable: false,
      reasonKind: 'connection',
    })
  })

  test('Given Node 连接错误 When 分类 Then 可重试并识别 DNS/超时', () => {
    expect(classifyModelFailure('read ECONNRESET')).toMatchObject({
      retryable: true,
      reasonKind: 'connection',
      safeCode: 'ECONNRESET',
    })
    expect(classifyModelFailure('connect ENOTFOUND api.example.com')).toMatchObject({
      retryable: true,
      detail: 'dns',
    })
    expect(classifyModelFailure('request ETIMEDOUT')).toMatchObject({
      retryable: true,
      detail: 'timeout',
    })
  })

  test('Given 5xx When 分类 Then 保留 Pi 原有可重试判断', () => {
    expect(classifyModelFailure('503 Service Unavailable')).toMatchObject({
      retryable: false,
      reasonKind: 'service',
    })
    expect(classifyModelFailure('503 Service Unavailable', true)).toMatchObject({
      retryable: true,
      reasonKind: 'service',
    })
  })

  test('Given 流中断文案 When 分类 Then 识别 stream_interrupted', () => {
    expect(classifyModelFailure('stream ended before a terminal event', true)).toMatchObject({
      retryable: true,
      reasonKind: 'stream_interrupted',
    })
  })

  test('Given 只有网络/流中断且可重试 When isRetryableNetworkFailure Then 返回 true', () => {
    expect(isRetryableNetworkFailure('read ECONNRESET')).toBe(true)
    expect(isRetryableNetworkFailure('429 Too Many Requests')).toBe(false)
  })

  test('Given 分类结果 When 生成提示 Then 使用稳定标题并附加错误码', () => {
    const description = describeModelFailure(classifyModelFailure('ERR_NAME_NOT_RESOLVED'))
    expect(description.title).toBe('域名解析失败')
    expect(description.message).toContain('错误代码：ERR_NAME_NOT_RESOLVED')
  })
})

describe('0.22.80 上游服务故障与确定性失败', () => {
  test('Given HTTP 524 When 分类 Then 无需 Pi 兜底也按服务故障重试', () => {
    expect(classifyModelFailure('HTTP 524 request timeout')).toMatchObject({
      retryable: true,
      reasonKind: 'service',
      safeCode: 'HTTP 524',
    })
    expect(classifyModelFailure('524')).toMatchObject({
      retryable: true,
      reasonKind: 'service',
      safeCode: 'HTTP 524',
    })
  })

  test('Given 524 混入账单或确定性文案 When 分类 Then 账单与确定性判定优先', () => {
    expect(classifyModelFailure('HTTP 524 insufficient_quota', true)).toMatchObject({
      retryable: false,
    })
    expect(classifyModelFailure('524 billing limit reached', true).retryable).toBe(false)
    expect(classifyModelFailure('HTTP 524: permission denied', true).retryable).toBe(false)
  })

  test('Given 上游网关故障文案 When 分类 Then 按服务故障重试', () => {
    for (const message of [
      'upstream connection error',
      'upstream tls error',
      'unexpected upstream stream error',
      'request timeout',
    ]) {
      expect(classifyModelFailure(message)).toMatchObject({
        retryable: true,
        reasonKind: 'service',
      })
    }
    expect(classifyModelFailure('429 request timeout')).toMatchObject({
      retryable: true,
      reasonKind: 'rate_limited',
      safeCode: 'HTTP 429',
    })
  })

  test('Given 确定性错误 When 分类 Then 即使 Pi 认为可重试也不重试', () => {
    for (const message of [
      'permission denied',
      'Unauthenticated: missing credentials',
      'invalid_api_key',
      'context_length_exceeded: maximum context length is 128000',
      'prompt is too long',
      'input is too long',
    ]) {
      expect(classifyModelFailure(message, true).retryable).toBe(false)
    }
  })

  test('Given 账单与额度类错误 When 分类 Then 即使带 429 或 Pi 兜底也不重试', () => {
    for (const message of [
      '429 GoUsageLimitError',
      'FreeUsageLimitError: free tier exhausted',
      '429 subscription_sharing_usage_limit_exceeded',
      '429 subscription_sharing_workplace_individual_usage_limit_exceeded',
      'billing hard limit reached',
    ]) {
      expect(classifyModelFailure(message, true).retryable).toBe(false)
    }
  })

  test('Given Gemini 错误体 When 分类 Then 按错误码归到正确 kind', () => {
    // 非流式：@google/genai 把 AIP-193 错误体直接放进 message。
    const rateLimited = classifyModelFailure(
      'ApiError: {"error":{"code":429,"message":"Rate limit exceeded. Please retry later.","status":"RESOURCE_EXHAUSTED"}}',
      true,
    )
    expect(rateLimited).toMatchObject({
      retryable: true,
      reasonKind: 'rate_limited',
      safeCode: 'HTTP 429',
    })
    // 流式：只有 gRPC 状态文本，错误体嵌在句子里。
    const unavailable = classifyModelFailure(
      'got status: UNAVAILABLE. {"error":{"code":503,"message":"The server is starting up.","status":"UNAVAILABLE"}}',
    )
    expect(unavailable).toMatchObject({
      retryable: false,
      reasonKind: 'service',
      safeCode: 'HTTP 503',
    })
    // 服务繁忙：沿用既有 overloaded → rate_limited 口径。
    const overloaded = classifyModelFailure(
      '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
      true,
    )
    expect(overloaded).toMatchObject({
      retryable: true,
      reasonKind: 'rate_limited',
    })
    // 只有状态文本、没有数字错误码时同样能归类。
    expect(classifyModelFailure('{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toMatchObject({
      retryable: false,
      reasonKind: 'rate_limited',
    })
  })

  test('Given 网卡或路由切换 When 分类 Then 仍是 connection 分类', () => {
    expect(classifyModelFailure('ERR_NETWORK_CHANGED')).toMatchObject({
      retryable: true,
      reasonKind: 'connection',
      detail: 'network-changed',
    })
    expect(classifyModelFailure('ERR_ADDRESS_UNREACHABLE')).toMatchObject({
      retryable: true,
      reasonKind: 'connection',
      detail: 'network-changed',
    })
  })
})
