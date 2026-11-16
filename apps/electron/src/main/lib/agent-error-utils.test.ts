import { describe, expect, test } from 'bun:test'
import { mapAgentErrorToTypedError } from './agent-error-utils'

describe('mapAgentErrorToTypedError - HTTP 状态优先分类', () => {
  test('Given OpenAI Responses 400 空响应体 When Pi 标记为 provider_error Then 不再显示服务繁忙', () => {
    const raw = 'proma-openai-responses-session API error (400): 400 status code (no body)'
    const result = mapAgentErrorToTypedError('provider_error', raw, raw, {
      channelName: '测试渠道',
      provider: 'openai-responses',
      modelId: 'gpt-5.6-sol',
      thinkingLevel: 'max',
    })

    expect(result.code).toBe('invalid_request')
    expect(result.title).toBe('请求被上游拒绝')
    expect(result.message).toContain('没有返回错误详情')
    expect(result.message).not.toContain('服务繁忙')
    expect(result.canRetry).toBe(true)
    expect(result.actions.map((action) => action.action)).toEqual(['settings', 'retry'])
    expect(result.details).toEqual([
      'HTTP 状态码: 400',
      '上游响应体: 空',
      '渠道: 测试渠道',
      '协议: openai-responses',
      '模型: gpt-5.6-sol',
      '思考深度: max',
      `原始错误: ${raw}`,
    ])
  })

  test('Given HTTP 400 带供应商详情 Then 保留详情并按不可重试的无效请求处理', () => {
    const raw = 'OpenAI API error (400): unsupported reasoning effort: max'
    const result = mapAgentErrorToTypedError('provider_error', raw, raw)

    expect(result.code).toBe('invalid_request')
    expect(result.title).toBe('请求无效')
    expect(result.message).toBe(raw)
    expect(result.canRetry).toBe(false)
    expect(result.actions.map((action) => action.action)).toEqual(['settings'])
    expect(result.details).toEqual([
      'HTTP 状态码: 400',
      `原始错误: ${raw}`,
    ])
  })

  test('Given bare 400 status code wording Then extracts the leading HTTP status', () => {
    const raw = '400 status code (no body)'
    const result = mapAgentErrorToTypedError('provider_error', raw, raw)

    expect(result.code).toBe('invalid_request')
    expect(result.title).toBe('请求被上游拒绝')
  })

  test.each([
    [429, 'rate_limited', '请求频率限制'],
    [502, 'service_error', '网关异常'],
    [503, 'service_unavailable', '服务暂时不可用'],
    [529, 'provider_error', '服务繁忙'],
  ] as const)('Given HTTP %i Then 保持既有 %s 分类', (status, code, title) => {
    const raw = `provider API error (${status}): ${status} status code (no body)`
    const result = mapAgentErrorToTypedError('provider_error', raw, raw)

    expect(result.code).toBe(code)
    expect(result.title).toBe(title)
    expect(result.canRetry).toBe(true)
  })

  test('Given provider_error 没有 HTTP 状态 Then 保持服务繁忙兜底', () => {
    const result = mapAgentErrorToTypedError('provider_error', 'upstream overloaded', 'upstream overloaded')

    expect(result.code).toBe('provider_error')
    expect(result.title).toBe('服务繁忙')
    expect(result.canRetry).toBe(true)
  })

  test.each([
    ['ERR_PROXY_CONNECTION_FAILED', '代理不可用'],
    ['ERR_NAME_NOT_RESOLVED', '域名解析失败'],
    ['ERR_INTERNET_DISCONNECTED', '网络已断开'],
    ['ERR_NETWORK_CHANGED', '网络已切换'],
    ['ERR_TIMED_OUT', '网络连接超时'],
  ])('Given %s When 归类为网络错误 Then 标题给出具体原因 %s', (code, expectedTitle) => {
    const raw = `fetch failed: ${code}`
    const result = mapAgentErrorToTypedError('unknown', raw, raw)

    expect(result.code).toBe('network_error')
    expect(result.title).toBe(expectedTitle)
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.canRetry).toBe(true)
    expect(result.actions.map((action) => action.action)).toEqual(['settings', 'retry'])
  })

  test('Given 流式响应中断 When 归类为网络错误 Then 提示响应传输中断', () => {
    const raw = 'fetch failed: ERR_INCOMPLETE_CHUNKED_ENCODING'
    const result = mapAgentErrorToTypedError('unknown', raw, raw)

    expect(result.code).toBe('network_error')
    expect(result.title).toBe('响应传输中断')
    expect(result.message).toContain('传输过程中断开')
  })

  test('Given 带明确 HTTP 状态码且含 ECONNRESET When 映射错误 Then 不误判为连接层网络错误', () => {
    const raw = 'provider API error (502): ECONNRESET while reading response'
    const result = mapAgentErrorToTypedError('unknown', raw, raw)

    expect(result.code).toBe('service_error')
    expect(result.title).toBe('网关异常')
    expect(result.code).not.toBe('network_error')
  })

  test('Given 空响应体错误包含疑似凭据 Then 诊断摘要会脱敏', () => {
    const raw = 'provider API error (400): 400 status code (no body), api_key=super-secret-value'
    const result = mapAgentErrorToTypedError('provider_error', raw, raw)
    const details = result.details?.join('\n') ?? ''

    expect(details).toContain('[REDACTED]')
    expect(details).not.toContain('super-secret-value')
  })
})
