import { describe, expect, test } from 'bun:test'
import { getGeminiModelCapability, normalizeGeminiThinkingLevel } from './gemini-model-capabilities'

describe('Gemini 4 Argon 思考档位（0.21.92-01）', () => {
  test('Given gemini-4-argon When 读取能力 Then 只暴露 low/medium/high 三档且默认 medium', () => {
    const capability = getGeminiModelCapability('gemini-4-argon')
    expect(capability?.thinkingLevels).toEqual(['low', 'medium', 'high'])
    expect(capability?.defaultThinkingLevel).toBe('medium')
    expect(capability?.contextWindow).toBe(1_048_576)
  })

  test('Given 带 vendor 前缀或 models/ 前缀 When 读取能力 Then 仍然命中', () => {
    expect(getGeminiModelCapability('google/gemini-4-argon')?.defaultThinkingLevel).toBe('medium')
    expect(getGeminiModelCapability('models/gemini-4-argon')?.defaultThinkingLevel).toBe('medium')
  })

  test('Given 旧会话残留 max 档 When 归一 Then 退回默认 medium 而不是原样下发', () => {
    // 未归一化会把 max 直接发成不存在的档位，官方 0.21.92 之前即报错。
    expect(normalizeGeminiThinkingLevel('gemini-4-argon', 'high')).toBe('high')
    expect(normalizeGeminiThinkingLevel('gemini-4-argon', 'max')).toBe('medium')
  })

  test('Given 旧会话残留 minimal 档 When 归一 Then 落到最低档 low', () => {
    expect(normalizeGeminiThinkingLevel('gemini-4-argon', 'minimal')).toBe('low')
  })

  test('Given 未指定档位 When 归一 Then 使用默认 medium', () => {
    expect(normalizeGeminiThinkingLevel('gemini-4-argon', undefined)).toBe('medium')
  })

  test('Given 三档模型 When 选择各合法档位 Then 原样保留', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(normalizeGeminiThinkingLevel('gemini-4-argon', level)).toBe(level)
    }
  })

  test('Given 未知 Gemini 模型 When 归一 Then 不改写请求', () => {
    expect(normalizeGeminiThinkingLevel('gemini-unknown-model', 'max')).toBe('max')
  })
})

describe('Gemini 4 Carbon / Hydrogen（0.22.60）', () => {
  test('Given Hydrogen When 读取能力 Then 支持 xhigh、默认 high 且使用 1,048,576 窗口', () => {
    const capability = getGeminiModelCapability('gemini-4-hydrogen')
    expect(capability?.thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(capability?.defaultThinkingLevel).toBe('high')
    expect(capability?.contextWindow).toBe(1_048_576)
    expect(capability?.maxOutputTokens).toBe(65_536)
  })

  test('Given Carbon When 读写能力 Then 与 Argon 同为三档且不支持 xhigh', () => {
    const capability = getGeminiModelCapability('gemini-4-carbon')
    expect(capability?.thinkingLevels).toEqual(['low', 'medium', 'high'])
    expect(capability?.defaultThinkingLevel).toBe('medium')
    expect(capability?.contextWindow).toBe(1_048_576)
    expect(normalizeGeminiThinkingLevel('gemini-4-carbon', 'xhigh')).toBe('medium')
  })

  test('Given Hydrogen 带 [1m] 尾缀 When 读取能力 Then 仍命中官方能力', () => {
    expect(getGeminiModelCapability('gemini-4-hydrogen[1m]')?.defaultThinkingLevel).toBe('high')
  })

  test('Given 官方 Argon/Carbon/Hydrogen 的任意网关后缀 When 非 proma 渠道 Then 不继承官方能力', () => {
    // 第三方渠道必须精确匹配，避免未登记型号被错误放大上下文或下发 xhigh。
    expect(getGeminiModelCapability('gemini-4-hydrogen-unregistered')).toBeUndefined()
    expect(getGeminiModelCapability('gemini-4-carbon-v2')).toBeUndefined()
  })
})
