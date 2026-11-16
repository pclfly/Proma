import { describe, expect, test } from 'bun:test'
import { inferContextWindow, inferKnownContextWindow } from './context-window'

describe('GPT 上下文修正', () => {
  test('Given GPT-6 Astra与SKU When 推断 Then 272K', () => {
    for (const id of ['gpt-6-astra', 'GPT-6-ASTRA', 'gpt-6-astra-fast', 'gpt-6-astra[1m]']) {
      expect(inferContextWindow(id)).toBe(272000)
    }
  })
  test('Given GPT-6.1 Sol When 推断 Then 500K但不误改其他家族', () => {
    expect(inferContextWindow('gpt-6.1-sol')).toBe(500000)
    expect(inferContextWindow(' GPT-6.1-SOL ')).toBe(500000)
    expect(inferContextWindow('gpt-6-sol')).toBe(372000)
    expect(inferContextWindow('gpt-6-luna')).toBe(372000)
    expect(inferContextWindow('gpt-5.6')).toBe(372000)
    expect(inferKnownContextWindow('gpt-6.1-solar')).toBeUndefined()
    expect(inferKnownContextWindow('gpt-6.1-sol-pro')).toBeUndefined()
  })
})
