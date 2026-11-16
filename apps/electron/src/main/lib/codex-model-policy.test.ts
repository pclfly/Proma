import { describe, expect, test } from 'bun:test'
import type { ChannelsConfig } from '@proma/shared'
import {
  filterManagedCodexChannelModels,
  isCodexModelAllowed,
  isManagedCodexModelAllowed,
  normalizeCodexModelId,
} from './codex-model-policy'

function config(channels: ChannelsConfig['channels']): ChannelsConfig {
  return { version: 1, channels }
}

function codexChannel(models: Array<{ id: string; name?: string; enabled?: boolean }>) {
  return {
    id: 'codex',
    name: 'ChatGPT Codex',
    provider: 'openai-codex' as const,
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: '',
    models: models.map((model) => ({ id: model.id, name: model.name ?? model.id, enabled: model.enabled ?? true })),
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('Codex 模型准入策略', () => {
  test('Given 官方白名单 ID When 判定 Then 允许且归一化 [1m] 与大小写', () => {
    for (const id of ['gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
      expect(isCodexModelAllowed(id)).toBe(true)
      expect(isCodexModelAllowed(` ${id.toUpperCase()}[1m] `)).toBe(true)
    }
    expect(normalizeCodexModelId(' GPT-6-ASTRA[1m] ')).toBe('gpt-6-astra')
  })

  test('Given 非白名单或近似 ID When 判定 Then 拒绝', () => {
    for (const id of ['gpt-6.1-solar', 'gpt-6-astra-fast', 'gpt-5.4', 'gpt-6', '', undefined]) {
      expect(isCodexModelAllowed(id)).toBe(false)
    }
  })

  test('Given 本地已验证的 Astra/Terra 变体 When 实际准入 Then 保留', () => {
    for (const id of ['gpt-6-astra-fast', 'gpt-6-astra-mini', 'gpt-6.1-terra-1']) {
      expect(isManagedCodexModelAllowed(id)).toBe(true)
    }
    expect(isManagedCodexModelAllowed('gpt-6.1-solar')).toBe(false)
  })

  test('Given Codex 渠道含白名单内外模型 When 过滤 Then 只保留白名单并归一化 ID', () => {
    const result = filterManagedCodexChannelModels(config([
      codexChannel([
        { id: 'gpt-6-astra' },
        { id: ' GPT-6-SOL[1m] ' },
        { id: 'gpt-6-astra-fast' },
        { id: 'gpt-6.1-terra-1' },
        { id: 'gpt-5.4' },
      ]),
    ]))

    expect(result.changed).toBe(true)
    expect(result.config.channels[0]?.models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-astra-fast',
      'gpt-6.1-terra-1',
    ])
  })

  test('Given 非 Codex 渠道 When 过滤 Then 原样保留', () => {
    const original = config([{
      ...codexChannel([{ id: 'gpt-5.4' }]),
      provider: 'openai',
    }])
    const result = filterManagedCodexChannelModels(original)
    expect(result.changed).toBe(false)
    expect(result.config).toBe(original)
  })

  test('Given 全部模型已合规 When 过滤 Then 不写回配置', () => {
    const original = config([codexChannel([{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-terra' }])])
    const result = filterManagedCodexChannelModels(original)
    expect(result.changed).toBe(false)
    expect(result.config).toBe(original)
  })
})
