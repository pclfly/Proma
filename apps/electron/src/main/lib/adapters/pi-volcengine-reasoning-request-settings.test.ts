import { describe, expect, test } from 'bun:test'
import {
  injectVolcengineReasoningLevel,
  resolveVolcengineReasoningCapability,
} from './pi-volcengine-reasoning-request-settings'

const payload = (model: string): Record<string, unknown> => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'enabled' },
  reasoning_effort: 'medium',
  temperature: 0.2,
})

describe('火山推理档位改写', () => {
  test('Given Seed 型号选择 high When 改写 Then 发送 enabled + high', () => {
    expect(injectVolcengineReasoningLevel(payload('doubao-seed-evolving'), { thinkingLevel: 'high' }))
      .toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  })

  test('Given Seed 型号选择 off When 改写 Then 关闭 thinking 并移除 reasoning_effort', () => {
    const body = injectVolcengineReasoningLevel(payload('doubao-seed-evolving'), { thinkingLevel: 'off' }) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in body).toBe(false)
  })

  test('Given GLM-5.3 只支持 low/high/max When 选择 minimal Then 落最近档 low', () => {
    expect(injectVolcengineReasoningLevel(payload('glm-5-3-flash-260828'), { thinkingLevel: 'minimal' }))
      .toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  })

  test('Given Kimi 型号不接受 thinking When 改写 Then 只发 reasoning_effort', () => {
    const body = injectVolcengineReasoningLevel(payload('kimi-k3-1-pro-261024'), { thinkingLevel: 'xhigh' }) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('max')
    expect('thinking' in body).toBe(false)
  })

  test('Given 未登记型号 When 改写 Then 原样返回，不猜测字段', () => {
    const input = payload('doubao-unlisted')
    expect(injectVolcengineReasoningLevel(input, { thinkingLevel: 'high' })).toBe(input)
    expect(resolveVolcengineReasoningCapability('doubao-unlisted')).toBeUndefined()
  })

  test('Given 目录声明只支持 high When 解析能力 Then 只暴露 off/high', () => {
    expect(resolveVolcengineReasoningCapability('doubao-seed-evolving', ['high']))
      .toEqual({ levels: ['off', 'high'], thinking: 'enabled-disabled' })
  })

  test('Given 缺少 messages 或档位 When 改写 Then 不改写请求', () => {
    const input = { model: 'doubao-seed-evolving' }
    expect(injectVolcengineReasoningLevel(input, { thinkingLevel: 'high' })).toBe(input)
    expect(injectVolcengineReasoningLevel(payload('doubao-seed-evolving'), {})).toBeDefined()
  })
})
