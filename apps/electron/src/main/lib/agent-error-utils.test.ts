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

  test('Given 空响应体错误包含疑似凭据 Then 诊断摘要会脱敏', () => {
    const raw = 'provider API error (400): 400 status code (no body), api_key=super-secret-value'
    const result = mapAgentErrorToTypedError('provider_error', raw, raw)
    const details = result.details?.join('\n') ?? ''

    expect(details).toContain('[REDACTED]')
    expect(details).not.toContain('super-secret-value')
  })
})
