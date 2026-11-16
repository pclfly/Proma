import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import { createPiRequestFailureBudget, PI_REQUEST_FAILURE_BUDGET_CODE } from './pi-request-failure-budget'
import { withPiStreamFinalizationGuard } from './pi-stream-finalization'

describe('Pi 原生会话累计失败预算集成', () => {
  test('Given 已写文件后交替失败与成功进度 When 累计预算耗尽 Then 终止且不重放副作用', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { getModel, isRetryableAssistantError, isContextOverflow } = await import('@earendil-works/pi-ai/compat')
    const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream')
    const dir = mkdtempSync(join(tmpdir(), 'proma-failure-budget-'))
    let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined
    try {
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 14, baseDelayMs: 0 } })
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false })
      modelRuntime.hasConfiguredAuth = () => true
      modelRuntime.getAuth = async () => ({ auth: { apiKey: 'isolated-test-not-a-real-key' } })
      const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, ...createPromaManagedResourceLoaderOptions(), systemPromptOverride: () => 'isolated test', agentsFilesOverride: () => ({ agentsFiles: [] }) })
      await loader.reload()
      const model = getModel('openai', 'gpt-4o')!
      let writes = 0, progress = 0, requests = 0
      session = (await sdk.createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: loader, settingsManager,
        sessionManager: sdk.SessionManager.inMemory(dir), noTools: 'builtin',
        customTools: [
          sdk.defineTool({ name: 'mock_write', label: 'write', description: '仅计数', parameters: Type.Object({}), execute: async () => { writes++; return { content: [{ type: 'text', text: 'saved' }], details: {} } } }),
          sdk.defineTool({ name: 'mock_progress', label: 'progress', description: '仅计数', parameters: Type.Object({}), execute: async () => { progress++; return { content: [{ type: 'text', text: 'updated' }], details: {} } } }),
        ],
      })).session
      const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
      session.agent.streamFunction = await withPiStreamFinalizationGuard(() => {
        budget.assertCanRequest()
        requests++
        const tool = requests === 1 ? 'mock_write' : requests === 3 ? 'mock_progress' : undefined
        const message: AssistantMessage = {
          role: 'assistant', content: tool ? [{ type: 'toolCall', id: `call-${requests}`, name: tool, arguments: {} }] : [],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: tool ? 'toolUse' : 'error', ...(!tool && { errorMessage: 'Request timed out.' }),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }
        const stream = new AssistantMessageEventStream()
        if (tool) stream.push({ type: 'done', reason: 'toolUse', message })
        else stream.push({ type: 'error', reason: 'error', error: message })
        return stream
      }, 5, (message, metrics) => budget.recordResult(message, metrics.durationMs))
      await session.prompt('完成写入后汇报；这是无网络的隔离测试')
      expect(requests).toBe(5)
      expect(writes).toBe(1)
      expect(progress).toBe(1)
      expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(1)
      expect(session.isStreaming).toBe(false)
      const final = session.messages.at(-1)
      expect(final?.role).toBe('assistant')
      if (final?.role !== 'assistant') throw new Error('缺少终态消息')
      expect(final.stopReason).toBe('error')
      expect(final.errorMessage).toContain(PI_REQUEST_FAILURE_BUDGET_CODE)
      expect(isRetryableAssistantError(final)).toBe(false)
      expect(budget.getState().failedRequests).toBe(3)
    } finally {
      session?.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
