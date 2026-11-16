import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAgentContextRequestPolicy } from '../agent-context-request-policy'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import { buildReadContextTool, getRecoverableContextMessages } from './pi-context-tool'

describe('Pi原生按需上下文完整回合', () => {
  for (const compacted of [false, true]) test(compacted
    ? 'Given 压缩后没有旧ref When 模型先查索引再读片段 Then 三次模拟请求完成且不重放历史工具'
    : 'Given 历史文件已读取并完成 When 新任务按引用核对 Then 两次模拟请求完成且不重读磁盘或重跑历史工具', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { getModel } = await import('@earendil-works/pi-ai/compat')
    const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream')
    const dir = mkdtempSync(join(tmpdir(), 'proma-on-demand-'))
    let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined
    try {
      const model = getModel('openai', 'gpt-4o')!
      const message = (content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
        role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      })
      const manager = sdk.SessionManager.inMemory(dir)
      const body = 'immutable-file-snapshot\n'.repeat(3000)
      manager.appendMessage({ role: 'user', content: '旧任务：读取文件并完成检查', timestamp: 1 })
      manager.appendMessage(message([{ type: 'toolCall', id: 'original-read', name: 'read', arguments: { path: '/not-actually-read.txt' } }], 'toolUse'))
      const entryId = manager.appendMessage({ role: 'toolResult', toolCallId: 'original-read', toolName: 'read', content: [{ type: 'text', text: body }], isError: false, timestamp: 2 })
      manager.appendMessage(message([{ type: 'text', text: '已确认文件检查完成；新任务不需要重复执行。' }], 'stop'))
      if (compacted) manager.appendCompaction('旧文件检查已完成。没有保留原文引用，需要时查材料索引。', manager.getLeafId()!, 10000)
      const policy = createAgentContextRequestPolicy({ getSourceMessages: () => getRecoverableContextMessages(manager.getBranch()) })
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false })
      modelRuntime.hasConfiguredAuth = () => true
      modelRuntime.getAuth = async () => ({ auth: { apiKey: 'isolated-test-not-a-real-key' } })
      const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, ...createPromaManagedResourceLoaderOptions(), systemPromptOverride: () => '隔离测试；无网络；按引用读取历史原文', agentsFilesOverride: () => ({ agentsFiles: [] }) })
      await loader.reload()
      session = (await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: loader, settingsManager, sessionManager: manager, noTools: 'builtin', customTools: [buildReadContextTool(sdk, policy)] })).session
      const previousTransform = session.agent.transformContext
      session.agent.transformContext = async (messages, signal) => policy.project(await previousTransform?.(messages, signal) ?? messages, signal)
      let requests = 0, reference = ''
      session.agent.streamFunction = (_model, context) => {
        requests++
        const history = context.messages.find((item) => item.role === 'toolResult' && item.toolCallId === 'original-read')
        if (compacted) expect(history).toBeUndefined()
        else { expect(history).toBeDefined(); expect(JSON.stringify(history)).not.toContain(body) }
        expect(JSON.stringify(context.messages)).toContain('已确认文件检查完成')
        const stream = new AssistantMessageEventStream()
        if (compacted && requests === 1) {
          const next = message([{ type: 'toolCall', id: 'discover-material', name: 'ReadContext', arguments: { query: '/not-actually-read.txt' } }], 'toolUse')
          stream.push({ type: 'done', reason: 'toolUse', message: next })
        } else if (requests === (compacted ? 2 : 1)) {
          const index = compacted ? context.messages.find((item) => item.role === 'toolResult' && item.toolCallId === 'discover-material') : history
          reference = JSON.stringify(index).match(/ctx_[a-f0-9]{64}/)![0]
          const next = message([{ type: 'toolCall', id: 'fetch-fragment', name: 'ReadContext', arguments: { reference, offset: 65000, limit: 100 } }], 'toolUse')
          stream.push({ type: 'done', reason: 'toolUse', message: next })
        } else {
          expect(requests).toBe(compacted ? 3 : 2)
          const result = context.messages.find((item) => item.role === 'toolResult' && item.toolCallId === 'fetch-fragment')
          expect(JSON.stringify(result)).toContain(JSON.stringify(body.slice(65000, 65100)).slice(1, -1))
          const next = message([{ type: 'text', text: '已按原始快照核对指定片段，没有重复执行旧工具。' }], 'stop')
          stream.push({ type: 'done', reason: 'stop', message: next })
        }
        return stream
      }
      await session.prompt('新任务：只核对旧文件65000起的100个字符，不要重新读文件或执行旧工具。')
      expect(requests).toBe(compacted ? 3 : 2)
      expect(session.messages.filter((item) => item.role === 'toolResult' && item.toolName === 'ReadContext')).toHaveLength(compacted ? 2 : 1)
      expect(JSON.stringify(manager.getEntry(entryId))).toContain(JSON.stringify(body).slice(1, -1))
      expect(session.isStreaming).toBe(false)
    } finally {
      session?.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
