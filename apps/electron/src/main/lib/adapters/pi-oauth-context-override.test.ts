import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { buildModel } from './pi-model-registry'

describe('OAuth 运行时上下文覆盖', () => {
  test.each(['openai-codex', 'github-copilot', 'xai'] as const)('Given %s内置修正 When 用户128K覆盖 Then 最终模型使用覆盖且目录不变', async (provider) => {
    const catalog: Model<Api> = { id: 'gpt-6-astra', name: 'test', api: 'openai-responses', provider, baseUrl: 'https://example.invalid', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 372000, maxTokens: 16000 }
    const sdk = { ModelRuntime: { create: async () => ({ getModels: () => [catalog], getAvailable: async () => [catalog], getModel: () => catalog }) } } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const input = { provider, model: 'gpt-6-astra', channelId: 'test', sessionId: 'test', channelModelContextWindow: 128000,
      codexOAuthCredentials: { access: 'fake', refresh: 'fake', expires: 9999999999999 },
      githubCopilotOAuthCredentials: { access: 'fake', refresh: 'fake', expires: 9999999999999 },
      xaiOAuthCredentials: { access: 'fake', refresh: 'fake', expires: 9999999999999 },
    } as unknown as PiAgentQueryOptions
    const result = await buildModel(sdk, input)
    expect(result.model.contextWindow).toBe(128000)
    expect(catalog.contextWindow).toBe(372000)
  })
})
