import { afterEach, describe, expect, test } from 'bun:test'
import {
  getDefaultReasoningProfileConfigData,
  normalizeReasoningLevel,
  resolveReasoningProfile,
  setReasoningProfileConfig,
} from './reasoning-profile'

afterEach(() => setReasoningProfileConfig(null))

describe('推理配置完整列表与每轮快照', () => {
  test('Given 删除内置 profile 的完整列表 When 解析 Then 不再被硬编码补回', () => {
    const profiles = getDefaultReasoningProfileConfigData().filter((p) => p.id !== 'glm-5.2')
    setReasoningProfileConfig(profiles, { authoritative: true })
    expect(resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('Given 显式空快照 When 全局仍有默认配置 Then 空快照优先且不改变全局', () => {
    setReasoningProfileConfig(getDefaultReasoningProfileConfigData(), { authoritative: true })
    expect(resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages', profiles: [] })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages' })?.id).toBe('glm-5.2')
  })

  test.each([
    ['deepseek-flash-latest', 'deepseek-flash'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'],
    ['glm-5.3-flashx', 'glm-5.3'],
    ['gpt-6-astra-pro', 'openai-reasoning-astra'],
    ['gpt-6-sol', 'openai-reasoning-sol-luna'],
    ['gpt-6-luna', 'openai-reasoning-sol-luna'],
    ['gpt-5.6-terra', 'openai-reasoning-max'],
  ])('Given 完整默认列表 When 解析 %s Then 命中 %s', (modelId, id) => {
    const transport = modelId.startsWith('gpt-') ? 'openai-responses' : 'anthropic-messages'
    expect(resolveReasoningProfile({ modelId, transport, profiles: getDefaultReasoningProfileConfigData() })?.id).toBe(id)
  })

  test('Given 完整默认列表 When 解析 chat-latest Then 不误判为推理模型', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5-chat-latest', transport: 'openai-responses', profiles: getDefaultReasoningProfileConfigData() })).toBeUndefined()
  })

  test('Given 默认长正则与自定义精确规则 When 匹配 Then 精确规则优先', () => {
    const defaults = getDefaultReasoningProfileConfigData()
    const custom = { ...defaults.find((p) => p.id === 'openai-reasoning-standard')!, id: 'custom-override', reasoning: false, matchRules: [{ type: 'exact' as const, value: 'gpt-5.5' }] }
    const profile = resolveReasoningProfile({ modelId: 'gpt-5.5', transport: 'openai-responses', profiles: [...defaults, custom] })
    expect(profile?.id).toBe('custom-override')
    expect(profile?.reasoning).toBe(false)
  })
  test('Given reasoning=false 且 levels 没有 off When 归一化 Then 仍然关闭思考', () => {
    const data = getDefaultReasoningProfileConfigData().find((p) => p.id === 'glm-5.3')!
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages', profiles: [{ ...data, reasoning: false }] })
    expect(normalizeReasoningLevel(profile, 'max')).toBe('off')
  })
})
