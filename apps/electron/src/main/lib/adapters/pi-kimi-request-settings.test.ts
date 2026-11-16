import { describe, expect, test } from 'bun:test'
import { injectKimiRequestSettings } from './pi-kimi-request-settings'

describe('Kimi K3.1 请求改写', () => {
  test('Given kimi-coding 的 K3.1 Pro When 注入 Then 写 reasoning_effort 并删除采样字段', () => {
    const payload = {
      model: 'k3.1-pro',
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      n: 1,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      thinking: { type: 'enabled' },
      messages: [],
    }
    const result = injectKimiRequestSettings(payload, {
      provider: 'kimi-coding',
      thinkingLevel: 'high',
    }) as Record<string, unknown>

    expect(result.reasoning_effort).toBe('high')
    expect(result.output_config).toBeUndefined()
    for (const field of ['temperature', 'top_p', 'top_k', 'n', 'presence_penalty', 'frequency_penalty', 'thinking']) {
      expect(result[field]).toBeUndefined()
    }
    expect(result.messages).toEqual([])
  })

  test('Given kimi-api 的 K3.1 Pro When 注入 Then 写 output_config.effort 且不写 reasoning_effort', () => {
    const result = injectKimiRequestSettings({
      model: 'kimi-k3.1-pro',
      output_config: { existing: true },
      reasoning_effort: 'medium',
      messages: [],
    }, {
      provider: 'kimi-api',
      thinkingLevel: 'high',
    }) as Record<string, unknown>

    expect(result.output_config).toEqual({ existing: true, effort: 'high' })
    expect(result.reasoning_effort).toBeUndefined()
  })

  test('Given K3.1 的 off When 注入 Then 归一化为 low 而不是关闭思考', () => {
    const result = injectKimiRequestSettings({
      model: 'k3.1-pro',
      messages: [],
    }, {
      provider: 'kimi-coding',
      thinkingLevel: 'off',
    }) as Record<string, unknown>

    expect(result.reasoning_effort).toBe('low')
  })

  test('Given 非 K3.1 模型 When 注入 Then 原样返回', () => {
    const payload = { model: 'kimi-k3', thinking: { type: 'enabled' } }
    expect(injectKimiRequestSettings(payload, {
      provider: 'kimi-api',
      thinkingLevel: 'high',
    })).toBe(payload)
  })
})
