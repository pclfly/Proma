import { describe, expect, test } from 'bun:test'
import { getDefaultReasoningProfileConfigData, resolveReasoningProfile } from './reasoning-profile'

describe('Kimi K3.1 推理档位（0.21.45-02）', () => {
  test('Given K3.1 API 模型 When 解析 profile Then 使用 api 档且默认 max', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'anthropic-messages' })
    expect(profile?.id).toBe('kimi-k3.1-api')
    expect(profile?.defaultLevel).toBe('max')
    expect([...(profile?.levels ?? [])]).toEqual(['low', 'high', 'max'])
  })

  test('Given K3.1 Coding 模型 When 解析 profile Then 使用 coding 档且默认 high', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3.1-coding', transport: 'anthropic-messages' })
    expect(profile?.id).toBe('kimi-k3.1-coding')
    expect(profile?.defaultLevel).toBe('high')
  })

  test('Given K3.1 When 传 off Then 映射为 low 而非关闭思考', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'anthropic-messages' })!
    expect(profile.normalize('off')).toBe('low')
  })

  test('Given K3.1 When 未传档位 Then 使用各自默认值', () => {
    const api = resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'anthropic-messages' })!
    const coding = resolveReasoningProfile({ modelId: 'kimi-k3.1-coding', transport: 'anthropic-messages' })!
    expect(api.normalize(undefined)).toBe('max')
    expect(coding.normalize(undefined)).toBe('high')
  })

  test('Given K3.1 与 K3 前缀重叠 When 解析 Then 不被 kimi-k3 规则吞掉', () => {
    expect(resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'anthropic-messages' })?.id).toBe('kimi-k3')
    expect(resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'anthropic-messages' })?.id).toBe('kimi-k3.1-api')
  })

  test('Given K3.1 When 两个 transport 都支持 Then 都能解析出 profile', () => {
    expect(resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'openai-completions' })).toBeDefined()
    expect(resolveReasoningProfile({ modelId: 'kimi-k3.1-api', transport: 'anthropic-messages' })).toBeDefined()
  })

  test('Given 内置默认配置 When 查找 K3.1 Then 出现在 UI 可回显数据里', () => {
    const ids = getDefaultReasoningProfileConfigData().map((p) => p.id)
    expect(ids).toContain('kimi-k3.1-api')
    expect(ids).toContain('kimi-k3.1-coding')
  })
})

describe('GPT-6.1 Terra 推理档位（0.21.67-01）', () => {
  test('Given gpt-6.1-terra When 解析 profile Then 使用 terra 档', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'openai-responses' })
    expect(profile?.id).toBe('openai-reasoning-terra')
  })

  test('Given terra 与 astra When 比较 Then 档位集合一致', () => {
    const terra = resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'openai-responses' })!
    const astra = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })!
    expect([...terra.levels]).toEqual([...astra.levels])
    expect(terra.defaultLevel).toBe(astra.defaultLevel)
  })

  test('Given gpt-6.1-terra-1 When 解析 Then 同样命中 terra 档', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-terra-1', transport: 'openai-responses' })?.id).toBe('openai-reasoning-terra')
  })

  test('Given terra When transport 不匹配 Then 不返回 profile', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('Given 近似 ID When 解析 Then 不被误判为 terra', () => {
    // gpt-6.1-sol 属 Sol 家族，不能落到 terra
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-responses' })?.id).not.toBe('openai-reasoning-terra')
  })

  test('Given 内置默认配置 When 查找 terra Then 出现在 UI 可回显数据里', () => {
    const ids = getDefaultReasoningProfileConfigData().map((p) => p.id)
    expect(ids).toContain('openai-reasoning-terra')
  })
})
