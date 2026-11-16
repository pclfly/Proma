import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAgentContextRequestPolicy } from '../agent-context-request-policy'
import { createContextCompactionProjectionExtension, getContextCompactionCancellationStatus, type ContextCompactionCancellation } from './pi-context-compaction'
import { getRecoverableContextMessages } from './pi-context-tool'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'

async function fixture(window = 128000, tooManyQuotes = false) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const { getModel } = await import('@earendil-works/pi-ai/compat')
  const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream')
  const dir = mkdtempSync(join(tmpdir(), 'proma-context-compact-'))
  try {
    const model = { ...getModel('openai', 'gpt-4o')!, contextWindow: window }
    const message = (content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
      role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    })
    const manager = sdk.SessionManager.inMemory(dir)
    const body = tooManyQuotes ? '<quoted_file path="x">x</quoted_file>'.repeat(17000) : `<quoted_file path="old.txt">${'FILE_RAW_SENTINEL'.repeat(10000)}</quoted_file>保留用户要求，不重跑。`
    manager.appendMessage({ role: 'user', content: body, timestamp: 1 })
    manager.appendMessage(message([{ type: 'toolCall', id: 'executed', name: 'bash', arguments: { command: 'SCRIPT_RAW_SENTINEL'.repeat(10000) } }], 'toolUse'))
    manager.appendMessage({ role: 'toolResult', toolCallId: 'executed', toolName: 'bash', content: [{ type: 'text', text: '已完成' }], isError: false, timestamp: 2 })
    manager.appendMessage(message([{ type: 'text', text: '旧任务已经完成，已确认结论。' }], 'stop'))
    manager.appendMessage({ role: 'user', content: '新任务：只需归档旧任务，不要重复执行。', timestamp: 3 })
    manager.appendMessage(message([{ type: 'text', text: '归档完成。' }], 'stop'))
    const policy = createAgentContextRequestPolicy({ getSourceMessages: () => getRecoverableContextMessages(manager.getBranch()) })
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 }, retry: { enabled: false } })
    const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false })
    runtime.hasConfiguredAuth = () => true
    runtime.getAuth = async () => ({ auth: { apiKey: 'isolated-test-not-a-real-key' } })
    const cancellations: ContextCompactionCancellation[] = []
    const extension = createContextCompactionProjectionExtension({ sdk, policy, onCancel: (reason) => { cancellations.push(reason) }, projectRequest: async (messages, signal) => policy.project(messages, signal), getSettings: () => settings.getCompactionSettings(model), additionalPromptChars: 100 })
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, ...createPromaManagedResourceLoaderOptions(), extensionFactories: [extension], systemPromptOverride: () => 'isolated test', agentsFilesOverride: () => ({ agentsFiles: [] }) })
    await loader.reload()
    const session = (await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: 'builtin' })).session
    const previous = session.agent.transformContext
    session.agent.transformContext = async (messages, signal) => policy.project(await previous?.(messages, signal) ?? messages, signal)
    const requests: string[] = []
    session.agent.streamFunction = (_model, context) => {
      requests.push(JSON.stringify(context.messages))
      const stream = new AssistantMessageEventStream()
      stream.push({ type: 'done', reason: 'stop', message: message([{ type: 'text', text: '已保留用户要求、完成状态和材料引用。' }], 'stop') })
      return stream
    }
    return { session, manager, policy, body, requests, cancellations, dispose: () => { session.dispose(); rmSync(dir, { recursive: true, force: true }) } }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}

describe('原生压缩也使用按需材料副本', () => {
  test('Given 大文件选区和长脚本 When 手动原生压缩 Then 摘要请求不含全文，原始branch不变并可索引取回', async () => {
    const f = await fixture()
    try {
      await f.session.compact()
      expect(f.requests.length).toBeGreaterThan(0)
      for (const request of f.requests) {
        expect(request).not.toContain('FILE_RAW_SENTINEL'.repeat(100))
        expect(request).not.toContain('SCRIPT_RAW_SENTINEL'.repeat(100))
        expect(request.length).toBeLessThan(15000)
      }
      expect(f.requests.join('\n')).toContain('ctx_')
      expect(f.requests.join('\n')).toContain('保留用户要求')
      expect(f.manager.getBranch().some((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === f.body)).toBe(true)
      const index = f.policy.list('old.txt')
      expect(index.materials.length).toBeGreaterThan(0)
      expect(f.policy.read(index.materials[0]!.reference, { limit: 17 }).text).toBe('FILE_RAW_SENTINEL')
    } finally { f.dispose() }
  })

  test('Given 16k窗口且原始材料超阈值但投影很小 When 原生prompt Then 不先发昂贵自动摘要请求', async () => {
    const f = await fixture(16000)
    try {
      await f.session.prompt('新用户任务：只需要文本结论')
      expect(f.requests).toHaveLength(1)
      expect(f.cancellations).toContain('fits')
      const status = getContextCompactionCancellationStatus('fits')
      expect(status.compact_result).toBe('noop')
      expect(status.compact_error).toBeUndefined()
      expect(getContextCompactionCancellationStatus().compact_result).toBe('failed')
      expect(f.manager.getBranch().some((entry) => entry.type === 'compaction')).toBe(false)
      expect(f.requests[0]).not.toContain('FILE_RAW_SENTINEL'.repeat(100))
    } finally { f.dispose() }
  })

  test('Given 投影准备失败 When 原生压缩 Then 显式取消而非被SDK吞错后发送原始全文', async () => {
    const f = await fixture(128000, true)
    try {
      await expect(f.session.compact()).rejects.toThrow('cancelled')
      expect(f.requests).toHaveLength(0)
      expect(f.cancellations).toContain('preparation_failed')
      expect(getContextCompactionCancellationStatus('preparation_failed').compact_error).toContain('准备失败')
      expect(f.manager.getBranch().some((entry) => entry.type === 'compaction')).toBe(false)
    } finally { f.dispose() }
  })
})
