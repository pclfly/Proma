/**
 * 推理能力配置化机制测试
 *
 * 验证：
 * 1. 内置默认 profile 能转成可序列化配置数据
 * 2. 配置数据能重建为完整运行时 ReasoningProfile（带 normalize/encodings）
 * 3. setReasoningProfileConfig 注入后，resolveReasoningProfile 按 matchRules 命中配置
 * 4. reasoning=false 时 resolveReasoningCapability 返回 undefined
 * 5. 未命中配置时回退内置硬编码 profile
 */

import { describe, expect, test } from 'bun:test'
import {
  buildReasoningProfileFromConfig,
  getDefaultReasoningProfileConfigData,
  resolveReasoningCapability,
  resolveReasoningProfile,
  setReasoningProfileConfig,
  type ReasoningProfileConfigData,
} from './reasoning-profile'

/** 深拷贝（测试体独立于 UI cloneProfile） */
function cloneConfig(data: ReasoningProfileConfigData): ReasoningProfileConfigData {
  return JSON.parse(JSON.stringify(data))
}

describe('getDefaultReasoningProfileConfigData', () => {
  test('返回内置全部 profile 且可序列化', () => {
    const defaults = getDefaultReasoningProfileConfigData()
    expect(defaults.length).toBeGreaterThanOrEqual(7)
    // 每个 profile 都带 id/levels/defaultLevel/reasoning/matchRules/encodings
    for (const p of defaults) {
      expect(typeof p.id).toBe('string')
      expect(Array.isArray(p.levels)).toBe(true)
      expect(typeof p.defaultLevel).toBe('string')
      expect(typeof p.reasoning).toBe('boolean')
      expect(Array.isArray(p.matchRules)).toBe(true)
      expect(typeof p.encodings).toBe('object')
    }
    // 可 JSON 往返（序列化能力验证）
    const data = JSON.parse(JSON.stringify(defaults))
    expect(Array.isArray(data)).toBe(true)
  })

  test('内置 openai-reasoning-standard 匹配 gpt-5 与 o3', () => {
    const defaults = getDefaultReasoningProfileConfigData()
    const std = defaults.find((p) => p.id === 'openai-reasoning-standard')
    expect(std).toBeDefined()
    expect(std!.matchRules.some((r) => r.type === 'prefix' && r.value === 'gpt-5')).toBe(true)
  })
})

describe('buildReasoningProfileFromConfig', () => {
  test('重建后带 normalize/encodings，normalize 收敛到合法档位', () => {
    const base = getDefaultReasoningProfileConfigData()[0]
    expect(base).toBeDefined()
    const profile = buildReasoningProfileFromConfig(cloneConfig(base!))
    expect(profile.normalize).toBeTypeOf('function')
    expect(profile.encodings).toBeDefined()
    // 请求档位不在 levels 时收敛到合法档位
    const normalized = profile.normalize('medium')
    expect(profile.levels).toContain(normalized)
  })
})

describe('setReasoningProfileConfig + resolveReasoningProfile', () => {
  test('注入用户配置后，按 matchRules 命中配置 profile', () => {
    const custom: ReasoningProfileConfigData = {
      id: 'custom-v9',
      levels: ['off', 'high', 'max'],
      defaultLevel: 'high',
      reasoning: true,
      matchRules: [{ type: 'prefix', value: 'v9' }],
      encodings: {
        'anthropic-messages': {
          kind: 'adaptive-effort',
          effortMap: { off: null, high: 'high', max: 'max' },
        },
      },
    }
    setReasoningProfileConfig([custom])

    const hit = resolveReasoningProfile({ modelId: 'v9-flash', transport: 'anthropic-messages' })
    expect(hit).toBeDefined()
    expect(hit!.id).toBe('custom-v9')
    expect(hit!.levels).toEqual(['off', 'high', 'max'])
  })

  test('config profile 缺该 transport encoding 时不命中', () => {
    const custom: ReasoningProfileConfigData = {
      id: 'custom-openai-only',
      levels: ['off', 'high'],
      defaultLevel: 'high',
      reasoning: true,
      matchRules: [{ type: 'exact', value: 'custom-openai-only' }],
      encodings: {
        'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', high: 'high' } },
      },
    }
    setReasoningProfileConfig([custom])
    // anthropic-messages 无 encoding，应回退内置（custom-openai-only 不在内置 → undefined）
    const hit = resolveReasoningProfile({ modelId: 'custom-openai-only', transport: 'anthropic-messages' })
    expect(hit).toBeUndefined()
  })

  test('reasoning=false 时 resolveReasoningCapability 返回 undefined', () => {
    const noThink: ReasoningProfileConfigData = {
      id: 'no-thinking',
      levels: ['off', 'low'],
      defaultLevel: 'off',
      reasoning: false,
      matchRules: [{ type: 'prefix', value: 'no-think-' }],
      encodings: {
        'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', low: 'low' } },
      },
    }
    setReasoningProfileConfig([noThink])
    const profile = resolveReasoningProfile({ modelId: 'no-think-x', transport: 'openai-completions' })
    expect(profile).toBeDefined()
    const capability = resolveReasoningCapability({ profile })
    expect(capability).toBeUndefined()
  })

  test('未命中配置时回退内置 deepseek-v4-flash', () => {
    setReasoningProfileConfig([{ id: 'other', levels: ['off', 'high'], defaultLevel: 'high', reasoning: true, matchRules: [{ type: 'prefix', value: 'other-' }], encodings: { 'anthropic-messages': { kind: 'adaptive-effort', effortMap: { off: null, high: 'high' } } } }])
    const hit = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    expect(hit).toBeDefined()
    expect(hit!.id).toBe('deepseek-v4-flash')
  })

  test('清空配置后恢复纯内置', () => {
    setReasoningProfileConfig([])
    const hit = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    expect(hit?.id).toBe('deepseek-v4-flash')
  })

  test('用户配置覆盖内置同名 id', () => {
    const customDeepSeek: ReasoningProfileConfigData = {
      id: 'deepseek-v4-flash',
      levels: ['off', 'low'],
      defaultLevel: 'low',
      reasoning: true,
      matchRules: [{ type: 'prefix', value: 'deepseek-v4-flash' }],
      encodings: {
        'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: { off: null, low: 'low' } },
      },
    }
    setReasoningProfileConfig([customDeepSeek])
    const hit = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    expect(hit?.id).toBe('deepseek-v4-flash')
    expect(hit?.levels).toEqual(['off', 'low'])
    expect(hit?.encodings['anthropic-messages']?.kind).toBe('deepseek-output-effort')
  })

  test('多个 profile 命中时选更具体的（gpt-5.6 命中 max，不因 standard 的 gpt-5 前缀被抢）', () => {
    // 复现真实运行时：主进程/渲染进程都注入内置默认配置
    setReasoningProfileConfig(getDefaultReasoningProfileConfigData())
    const maxCap = resolveReasoningCapability({
      profile: resolveReasoningProfile({ modelId: 'gpt-5.6-luna', transport: 'openai-completions' }),
    })
    expect(maxCap?.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    // 对照组：gpt-5.4 无 gpt-5.6 专属 max，仍命中 standard（无 max）
    const stdCap = resolveReasoningCapability({
      profile: resolveReasoningProfile({ modelId: 'gpt-5.4', transport: 'openai-completions' }),
    })
    expect(stdCap?.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    // 恢复干净态
    setReasoningProfileConfig([])
  })
})
