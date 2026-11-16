import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { disableUnconfiguredDeepSeekChannel } from './deepseek-channel-migration'

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    models: [{ id: 'deepseek-v4', name: 'DeepSeek V4', enabled: true }],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('DeepSeek 未配置渠道迁移', () => {
  test('Given 已启用且 API Key 为空 When 迁移 Then 关闭渠道', () => {
    const original = channel()
    const migrated = disableUnconfiguredDeepSeekChannel(original, '')
    expect(migrated.enabled).toBe(false)
    expect(migrated).not.toBe(original)
  })

  test('Given 已启用且有 API Key When 迁移 Then 原样返回', () => {
    const original = channel()
    expect(disableUnconfiguredDeepSeekChannel(original, 'sk-test')).toBe(original)
  })

  test('Given 非 DeepSeek 或已停用 When 迁移 Then 原样返回', () => {
    const openai = channel({ provider: 'openai' })
    const disabled = channel({ enabled: false })
    expect(disableUnconfiguredDeepSeekChannel(openai, '')).toBe(openai)
    expect(disableUnconfiguredDeepSeekChannel(disabled, '')).toBe(disabled)
  })
})
