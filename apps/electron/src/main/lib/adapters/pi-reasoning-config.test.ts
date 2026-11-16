import { describe, expect, test } from 'bun:test'
import { clampThinkingLevel, getSupportedThinkingLevels, streamSimple } from '@earendil-works/pi-ai/compat'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { getDefaultReasoningProfileConfigData, type ReasoningProfileConfigData } from '@proma/shared'
import { applyPiReasoningProfile, compilePiReasoningCapabilities } from './pi-model-registry'
import { resolvePiThinkingLevel } from '../agent-thinking-level'
import { injectOpenAIReasoningLevel } from './pi-openai-reasoning-request-settings'
import { injectDeepSeekReasoningLevel } from './pi-deepseek-reasoning-request-settings'
import { resolveReasoningProfile, resolveReasoningCapability } from '@proma/shared'

function customProfile(reasoning = true): ReasoningProfileConfigData {
  return {
    id: 'my-arbitrary-profile', reasoning, levels: ['off', 'high', 'max'], defaultLevel: 'high',
    matchRules: [{ type: 'exact', value: 'custom-model' }],
    encodings: { 'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', high: 'medium', max: 'ultra' } } },
  }
}
function model(api: Api = 'openai-responses'): Model<Api> {
  return {
    id: 'custom-model', name: 'Test', api, provider: 'openai', baseUrl: 'https://example.invalid',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
  }
}

describe('Pi 推理配置端到端映射（离线）', () => {
  test('Given JSON 跨进程快照 When 应用模型能力 Then 使用自定义映射且不污染 catalog', () => {
    const snapshot = JSON.parse(JSON.stringify([customProfile()])) as ReasoningProfileConfigData[]
    const catalog = model()
    const patched = applyPiReasoningProfile(catalog, snapshot)
    expect(patched.reasoning).toBe(true)
    expect(patched.thinkingLevelMap?.max).toBe('ultra')
    expect(getSupportedThinkingLevels(patched)).toEqual(['off', 'high', 'max'])
    expect(clampThinkingLevel(patched, 'max')).toBe('max')
    expect(catalog.reasoning).toBe(false)
    expect(catalog.thinkingLevelMap).toBeUndefined()
  })
  test('Given 开启和关闭快照并存 When 编译 Then 不相互影响且关闭时始终 off', () => {
    const enabled = [customProfile()]
    const disabled = [{ ...customProfile(false), levels: ['high', 'max'] as const }].map((p) => ({ ...p, levels: [...p.levels] }))
    expect(compilePiReasoningCapabilities('openai-responses', 'custom-model', disabled)?.reasoning).toBe(false)
    expect(resolvePiThinkingLevel({ agentEffort: 'max' }, { reasoningLevel: 'max' }, 'openai-responses', 'custom-model', undefined, disabled)).toBe('off')
    expect(clampThinkingLevel(applyPiReasoningProfile({ ...model(), reasoning: true }, disabled), 'max')).toBe('off')
    expect(applyPiReasoningProfile(model(), enabled).reasoning).toBe(true)
  })
  test('Given 允许 max 但未写映射 When 编译 Then Pi 保留 max 不降级', () => {
    const profile = customProfile()
    profile.encodings['openai-responses']!.effortMap = {}
    expect(clampThinkingLevel(applyPiReasoningProfile(model(), [profile]), 'max')).toBe('max')
  })
  test('Given 空快照 When 应用 Then 保留 catalog 能力', () => {
    const catalog = model()
    expect(applyPiReasoningProfile(catalog, [])).toBe(catalog)
  })
  test('Given 自定义 profile ID 和已存在 effort When 构造请求 Then 自定义值优先', () => {
    const profile = resolveReasoningProfile({ modelId: 'custom-model', transport: 'openai-responses', profiles: [customProfile()] })!
    expect(injectOpenAIReasoningLevel({ model: 'custom-model', reasoning: { effort: 'high', summary: 'auto' } }, { profile, thinkingLevel: 'high' })).toEqual({
      model: 'custom-model', reasoning: { effort: 'medium', summary: 'auto' },
    })
  })
  test('Given Copilot 混合协议 When 选择 high Then 不受 Anthropic 专属配置影响', () => {
    const data = getDefaultReasoningProfileConfigData().find((p) => p.id === 'kimi-k3')!
    data.encodings['anthropic-messages']!.effortMap.high = null
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'openai-completions', profiles: [data] })!
    const capability = resolveReasoningCapability({ profile })
    expect(resolvePiThinkingLevel({ agentEffort: 'high' }, { reasoningLevel: 'high' }, 'github-copilot', 'kimi-k3', capability, [data])).toBe('high')
    expect(resolvePiThinkingLevel({ agentEffort: 'max' }, { reasoningLevel: 'max' }, 'github-copilot', 'kimi-k3', undefined, [data])).toBe('off')
  })
  test('Given profile capability 不允许 off When Copilot 归一化 Then 遵从 profile 的最近档位', () => {
    const profiles = getDefaultReasoningProfileConfigData()
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses', profiles })!
    expect(resolvePiThinkingLevel({ agentThinking: { type: 'disabled' } }, { reasoningLevel: 'off' }, 'github-copilot', 'gpt-6-astra', resolveReasoningCapability({ profile }), profiles)).toBe('low')
  })
  test('Given 清空上游映射 When 生成请求 Then 保留合法 off 和 DeepSeek 编码', () => {
    const data = customProfile()
    data.encodings['openai-responses']!.effortMap = {}
    const profile = resolveReasoningProfile({ modelId: 'custom-model', transport: 'openai-responses', profiles: [data] })!
    expect(injectOpenAIReasoningLevel({ reasoning: { effort: 'none' } }, { profile, thinkingLevel: 'off' })).toEqual({ reasoning: { effort: 'none' } })
    const ds = getDefaultReasoningProfileConfigData().find((p) => p.id === 'deepseek-v4-flash')!
    delete ds.encodings['anthropic-messages']!.effortMap.high
    const deepseek = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages', profiles: [ds] })!
    expect(injectDeepSeekReasoningLevel({ thinking: { type: 'enabled', budget_tokens: 16384 } }, { profile: deepseek, thinkingLevel: 'high' })).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: 'high' } })
  })
  test('Given Codex 的专属 API 名称 When 应用快照 Then 仍映射到 Responses profile', () => {
    const patched = applyPiReasoningProfile(model('openai-codex-responses'), [customProfile()])
    expect(patched.reasoning).toBe(true)
    expect(patched.thinkingLevelMap?.max).toBe('ultra')
  })
  test('Given 映射为 null 的档位 When capability 与 Pi clamp Then 都排除此档位', () => {
    const data = customProfile()
    data.encodings['openai-responses']!.effortMap.high = null
    const profile = resolveReasoningProfile({ modelId: 'custom-model', transport: 'openai-responses', profiles: [data] })!
    expect(profile.levels).toEqual(['off', 'max'])
    expect(profile.normalize('high')).toBe('max')
    expect(getSupportedThinkingLevels(applyPiReasoningProfile(model(), [data]))).toEqual(['off', 'max'])
  })
  test.each(['openai-responses', 'openai-completions', 'anthropic-messages'] as const)(
    'Given %s 的真实 Pi provider When 离线捕获 body Then 自定义映射或关闭思考生效', async (api) => {
      const run = async (reasoning: boolean): Promise<Record<string, unknown>> => {
        const data = customProfile(reasoning)
        data.encodings = { [api]: { kind: api === 'anthropic-messages' ? 'adaptive-effort' : 'openai-reasoning-effort', effortMap: { max: 'high' } } }
        const catalog = { ...model(api), compat: api === 'anthropic-messages' ? { supportsMidConvoEffort: true } : undefined }
        const patched = applyPiReasoningProfile(catalog, [data])
        let captured: Record<string, unknown> | undefined
        const options = {
          apiKey: 'test-key', reasoning: 'max' as const,
          onPayload: (payload: unknown) => { captured = payload as Record<string, unknown>; throw new Error('offline-capture-stop') },
          fetch: Object.assign(async () => { throw new Error('测试禁止联网') }, { preconnect: () => {} }),
        }
        await streamSimple(patched, { messages: [] }, options).result()
        expect(captured).toBeDefined()
        return captured!
      }
      const enabled = await run(true)
      const disabled = await run(false)
      if (api === 'anthropic-messages') {
        // Pi 1.5.0 对 supportsMidConvoEffort 模型使用托管 effort：顶层固定 low
        // 作为缓存锚点，真实档位写入最后一条 system 消息的 effort 标记。
        expect(enabled.output_config).toEqual({ effort: 'low' })
        expect(enabled.thinking).toMatchObject({ type: 'adaptive' })
        expect((enabled.messages as Array<Record<string, unknown>>).at(-1)).toEqual({
          role: 'system', content: [], output_config: { effort: 'high' },
        })
        expect(disabled.thinking).toBeUndefined()
        expect(disabled.output_config).toBeUndefined()
      } else if (api === 'openai-completions') {
        expect(enabled.reasoning_effort).toBe('high')
        expect(disabled.reasoning_effort).toBeUndefined()
      } else {
        expect(enabled.reasoning).toMatchObject({ effort: 'high' })
        expect(disabled.reasoning).toBeUndefined()
      }
    },
  )
  test('Given reasoning=false When 请求扩展执行 Then 不重新注入思考字段', () => {
    const profile = resolveReasoningProfile({ modelId: 'custom-model', transport: 'openai-responses', profiles: [customProfile(false)] })!
    const payload = { model: 'custom-model' }
    expect(injectOpenAIReasoningLevel(payload, { profile, thinkingLevel: 'max' })).toBe(payload)
    const data = getDefaultReasoningProfileConfigData().find((p) => p.id === 'deepseek-v4-flash')!
    const deepseek = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages', profiles: [{ ...data, reasoning: false }] })!
    expect(injectDeepSeekReasoningLevel({ model: 'deepseek-v4-flash' }, { profile: deepseek, thinkingLevel: 'max' })).toEqual({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' } })
  })
})
