import { describe, expect, test } from 'bun:test'
import { resolvePiBuiltInContextWindow } from './pi-model-registry'

describe('模型列表内置上下文元数据', () => {
  test('Given 目录模型/共享规则 When 获取内置窗口 Then 返回已知值', async () => {
    expect(await resolvePiBuiltInContextWindow('custom', 'gpt-6-astra')).toBe(272000)
    expect(await resolvePiBuiltInContextWindow('anthropic', 'claude-sonnet-4-6')).toBe(1000000)
    expect(await resolvePiBuiltInContextWindow('openai-codex', 'gpt-6-astra')).toBe(272000)
  })
  test('Given 未知模型 When 获取内置窗口 Then 不把运行时兜底当能力', async () => {
    expect(await resolvePiBuiltInContextWindow('custom', 'unknown-model')).toBeUndefined()
    expect(await resolvePiBuiltInContextWindow('custom', '')).toBeUndefined()
  })
})
