import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import type { AssistantMessage } from '@earendil-works/pi-ai'

describe('Pi SDK 受管会话兼容性', () => {
  test.each([false, true])('Given 工具完成后遇429且取消=%s When AgentSession原生重试 Then 不重放工具或用户输入', async (cancelOnRetry) => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { getModel } = await import('@earendil-works/pi-ai/compat')
    const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream')
    const dir = mkdtempSync(join(tmpdir(), 'proma-pi-sdk-'))
    let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined
    try {
      const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
      })
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-store.json'),
        allowModelNetwork: false, refreshOnCreate: false,
      })
      // mock provider 不需要任何用户凭据，禁止进入真实认证路径。
      modelRuntime.hasConfiguredAuth = () => true
      modelRuntime.getAuth = async () => ({ auth: { apiKey: 'isolated-test-not-a-real-key' } })
      const loader = new sdk.DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager, ...createPromaManagedResourceLoaderOptions(),
        systemPromptOverride: () => 'isolated test', agentsFilesOverride: () => ({ agentsFiles: [] }),
      })
      await loader.reload()
      const model = getModel('openai', 'gpt-4o')!
      let executions = 0, requests = 0
      const result = await sdk.createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: loader, settingsManager,
        sessionManager: sdk.SessionManager.inMemory(dir),
        noTools: 'builtin',
        customTools: [sdk.defineTool({
          name: 'mock_write', label: 'mock_write', description: '仅测试计数，不写文件',
          parameters: Type.Object({}),
          execute: async () => {
            executions++
            return { content: [{ type: 'text', text: 'ok' }], details: {} }
          },
        })],
      })
      session = result.session
      expect(session.getActiveToolNames()).toEqual(['mock_write'])
      let retries = 0
      session.subscribe((event) => {
        if (event.type === 'auto_retry_start') {
          retries++
          if (cancelOnRetry) void session?.abort()
        }
      })
      session.agent.streamFunction = (_model, context) => {
        requests++
        if (requests > 1) expect(context.messages.some((entry) => entry.role === 'toolResult')).toBe(true)
        const message: AssistantMessage = {
          role: 'assistant',
          content: requests === 1
            ? [{ type: 'toolCall', id: 'one', name: 'mock_write', arguments: {} }]
            : [{ type: 'text', text: 'completed' }],
          api: model.api, provider: model.provider, model: model.id,
          stopReason: requests === 1 ? 'toolUse' : requests === 2 ? 'error' : 'stop', timestamp: Date.now(),
          ...(requests === 2 && { errorMessage: '429 Too Many Requests' }),
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
        const stream = new AssistantMessageEventStream()
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message })
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
        return stream
      }
      await session.prompt('run isolated test')
      expect(executions).toBe(1)
      expect(requests).toBe(cancelOnRetry ? 2 : 3)
      expect(retries).toBe(1)
      expect(session.messages.filter((entry) => entry.role === 'user')).toHaveLength(1)
      if (!cancelOnRetry) {
        const final = session.messages.at(-1)
        expect(final?.role).toBe('assistant')
        if (final?.role !== 'assistant') throw new Error('缺少最终 assistant 消息')
        expect(final.stopReason).toBe('stop')
        expect(final.content).toEqual([{ type: 'text', text: 'completed' }])
      }
      expect(session.isStreaming).toBe(false)
    } finally {
      session?.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
