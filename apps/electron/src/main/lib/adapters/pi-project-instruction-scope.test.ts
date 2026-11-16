import { describe, expect, test } from 'bun:test'
import { resolve, relative } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { runAgentLoop, runAgentLoopContinue } from '@earendil-works/pi-agent-core'
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript'
import { getModel } from '@earendil-works/pi-ai/compat'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'
import { createProjectScopeState } from './pi-project-scope-state'
import type { ProjectInstructionSource, resolveProjectInstructions } from '../project-instruction-resolver'

function fixture() {
  const root = resolve('synthetic-scope-root')
  const state = SessionManager.inMemory(root)
  const initialId = state.appendCustomEntry('fixture-root', {})
  const scopeState = createProjectScopeState(state)
  const sources = new Map<string, ProjectInstructionSource>()
  const source = (scope: string, content: string, kind: 'agents' | 'claude' = 'agents'): ProjectInstructionSource => ({
    path: resolve(root, scope, kind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'), relativePath: `${scope}/AGENTS.md`, scopeRoot: scope, kind, content, contentHash: content,
  })
  sources.set('nested', source('nested', 'RULE_V1'))
  const resolver: typeof resolveProjectInstructions = ({ targetPath }) => {
    const scope = relative(root, targetPath ?? root).split(/[\\/]/).join('/')
    const result = sources.get(scope)
    return { projectRoot: root, sources: result ? [result] : [], diagnostics: [], totalBytes: result?.content.length ?? 0 }
  }
  const create = () => new ProjectInstructionScopeController({ projectRoot: root, cwd: root, initialSources: [], sessionState: scopeState, resolveInstructions: resolver })
  const call = (scope = 'nested', name = 'write', file = 'file.txt') => ({ toolName: name, input: { path: name === 'ls' ? resolve(root, scope) : resolve(root, scope, file) } })
  return { root, state, initialId, scopeState, sources, source, create, call, resolver }
}

function finalMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  const model = getModel('openai', 'gpt-4o')!
  return { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...(stopReason === 'error' ? { errorMessage: '503' } : {}) }
}
function stream(message: AssistantMessage) {
  const result = new AssistantMessageEventStream()
  if (message.stopReason === 'error') result.push({ type: 'error', reason: 'error', error: message })
  else result.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message })
  return result
}

describe('项目子目录指令每请求激活', () => {
  test('Given 同批调用尚未投递 When 重试 Then 仍拦截；下一请求投递后才允许', () => {
    const f = fixture(), controller = f.create()
    expect(controller.beforeToolCall(f.call())?.block).toBe(true)
    expect(controller.beforeToolCall(f.call())?.block).toBe(true)
    const messages = controller.projectContext([])
    expect(getCurrentSystemPrompt(messages as TranscriptContext['messages'])).toContain('RULE_V1')
    expect(controller.beforeToolCall(f.call())).toBeUndefined()
    expect(f.state.getBranch().filter((e) => e.type === 'custom')).toHaveLength(1) // 不追加scope树节点
  })
  test('Given 规则改变及controller重建 When 请求投影 Then 重新验证当前内容并不复用已读凭据', () => {
    const f = fixture(), first = f.create()
    first.beforeToolCall(f.call())
    first.projectContext([])
    f.sources.set('nested', f.source('nested', 'RULE_V2'))
    expect(first.beforeToolCall(f.call())?.block).toBe(true)
    const restored = f.create()
    const result = getCurrentSystemPrompt(restored.projectContext([]) as TranscriptContext['messages'])
    expect(result).toContain('RULE_V2')
    expect(result).not.toContain('RULE_V1')
    expect(restored.beforeToolCall(f.call())).toBeUndefined()
  })
  test('Given 不同分支或根外恢复记录 When 请求投影 Then 不引入其他范围', () => {
    const f = fixture()
    f.state.appendCustomEntry('branch-a', {})
    f.scopeState.save({ version: 1, projectRoot: f.root, directories: ['../outside', resolve(f.root, 'nested')] })
    expect(JSON.stringify(f.create().projectContext([]))).not.toContain('RULE_V1')
    const controller = f.create()
    controller.beforeToolCall(f.call())
    expect(JSON.stringify(controller.projectContext([]))).toContain('RULE_V1')
    f.state.branch(f.initialId)
    expect(JSON.stringify(controller.projectContext([]))).not.toContain('RULE_V1')
  })
  test('Given 规则投影失败或保存失败 When 工具请求 Then 不放行', () => {
    const f = fixture()
    const controller = new ProjectInstructionScopeController({ projectRoot: f.root, cwd: f.root, initialSources: [], resolveInstructions: f.resolver, sessionState: { load: () => undefined, save: () => { throw new Error('write failed') } } })
    expect(controller.beforeToolCall(f.call())?.reason).toContain('无法保存')
    controller.projectContext([])
    expect(controller.beforeToolCall(f.call())?.block).toBe(true)
    const failed = new ProjectInstructionScopeController({ projectRoot: f.root, cwd: f.root, initialSources: [], resolveInstructions: () => { throw new Error('read failed') } })
    expect(JSON.stringify(failed.projectContext([]))).toContain('项目指令刷新失败')
    expect(failed.beforeToolCall(f.call())?.block).toBe(true)
  })
  test('Given diagnostics表示规则无法核验 When 空sources Then 不视作无规则放行', () => {
    const f = fixture()
    const controller = new ProjectInstructionScopeController({ projectRoot: f.root, cwd: f.root, initialSources: [], resolveInstructions: () => ({ projectRoot: f.root, sources: [], diagnostics: [{ path: 'nested/AGENTS.md', message: '无法读取: EACCES' }], totalBytes: 0 }) })
    expect(JSON.stringify(controller.projectContext([]))).toContain('项目指令刷新失败')
    expect(controller.beforeToolCall(f.call())?.block).toBe(true)
  })
  test('Given SDK特殊路径和默认cwd When 规则检查 Then 使用实际目标而非字面路径', () => {
    const f = fixture(), controller = f.create()
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: '@nested/file.txt' } })?.block).toBe(true)
    controller.projectContext([])
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: '@nested/file.txt' } })).toBeUndefined()
  })
  test('Given legacy规则 When 已投递 Then 仍阻止普通写入，只允许指定迁移文件', () => {
    const f = fixture()
    f.sources.set('nested', f.source('nested', 'LEGACY', 'claude'))
    const controller = f.create()
    controller.beforeToolCall(f.call())
    controller.projectContext([])
    expect(controller.beforeToolCall(f.call())?.reason).toContain('legacy')
    expect(controller.beforeToolCall(f.call('nested', 'write', 'AGENTS.md'))).toBeUndefined()
  })
  test('Given 真实loop首次拦截后请求失败 When 原生continue Then 重投规则且只执行新调用一次', async () => {
    const f = fixture(), controller = f.create()
    let requests = 0, writes = 0
    const context: AgentContext = {
      messages: [],
      tools: [{
        name: 'write', label: 'write', description: 'fixture', parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (_id, args) => {
          writes++
          expect((args as { content: string }).content).toBe('after-reading-rule')
          return { content: [{ type: 'text', text: 'ok' }], details: {} }
        },
      }],
    }
    const config: AgentLoopConfig = {
      model: getModel('openai', 'gpt-4o')!,
      convertToLlm: (messages) => messages as TranscriptContext['messages'],
      transformContext: async (messages) => controller.projectContext(messages),
      beforeToolCall: async ({ toolCall }) => controller.beforeToolCall({ toolName: toolCall.name, input: toolCall.arguments }),
    }
    const provider: StreamFn = (_model, request) => {
      requests++
      if (requests === 1) return stream(finalMessage([{ type: 'toolCall', id: 'blocked', name: 'write', arguments: { ...f.call().input, content: 'must-not-write' } }], 'toolUse'))
      expect(getCurrentSystemPrompt(request.messages)).toContain('RULE_V1')
      if (requests === 2) return stream(finalMessage([], 'error'))
      if (requests === 3) return stream(finalMessage([{ type: 'toolCall', id: 'new-decision', name: 'write', arguments: { ...f.call().input, content: 'after-reading-rule' } }], 'toolUse'))
      return stream(finalMessage([{ type: 'text', text: 'done' }]))
    }
    const input: AgentMessage[] = [{ role: 'user', content: 'edit fixture', timestamp: 1 }]
    context.messages = await runAgentLoop(input, context, config, () => {}, undefined, provider)
    expect(writes).toBe(0)
    context.messages = context.messages.filter((m) => m.role !== 'assistant' || m.stopReason !== 'error')
    const continued = await runAgentLoopContinue(context, config, () => {}, undefined, provider)
    expect(writes).toBe(1)
    expect(requests).toBe(4)
    expect(context.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(continued.at(-1)?.role).toBe('assistant')
  })
})
