import { describe, expect, test } from 'bun:test'
import { parseVolcengineModels } from './volcengine-models'

describe('火山方舟模型目录解析', () => {
  test('Given 带 token_limits 与 effort 的目录 When 解析 Then 保留能力与默认档位', () => {
    const parsed = parseVolcengineModels({
      data: [{
        id: 'doubao-seed-evolving',
        name: 'Doubao Seed Evolving',
        status: 'available',
        token_limits: { context_window: 512_000, max_input_token_length: 480_000, max_output_token_length: 32_000 },
        modalities: { input_modalities: ['text', 'image'] },
        features: { thinking: { type: 'enabled-disabled' } },
        effort: { supported_levels: ['low', 'medium', 'high'], default_level: 'medium' },
      }],
    })

    expect(parsed).toEqual([{
      id: 'doubao-seed-evolving',
      name: 'Doubao Seed Evolving',
      status: 'available',
      contextWindow: 512_000,
      maxInputTokens: 480_000,
      maxOutputTokens: 32_000,
      inputModalities: ['text', 'image'],
      thinkingType: 'enabled-disabled',
      effort: { supportedLevels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
    }])
  })

  test('Given 条目缺 id 或字段类型不符 When 解析 Then 跳过坏条目且不抛错', () => {
    const parsed = parseVolcengineModels({
      data: [
        { name: 'missing id' },
        { id: '  ' },
        { id: 'ok-model', token_limits: { context_window: -1 }, effort: { supported_levels: 'low' } },
      ],
    })

    expect(parsed).toEqual([{ id: 'ok-model', name: 'ok-model' }])
  })

  test('Given 非对象或 data 非数组 When 解析 Then 返回空列表', () => {
    expect(parseVolcengineModels(null)).toEqual([])
    expect(parseVolcengineModels({ data: {} })).toEqual([])
    expect(parseVolcengineModels({ data: [{ id: 'm' }], extra: true })).toHaveLength(1)
  })
})
