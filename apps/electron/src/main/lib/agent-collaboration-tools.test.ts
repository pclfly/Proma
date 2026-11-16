import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Check } from 'typebox/value'
import type { TSchema } from 'typebox'
import { AGENT_RUNTIME_METHODS, createAgentRuntimeRequest } from '@proma/shared'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import type { AgentSessionMeta, SDKMessage } from '@proma/shared'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { publishAgentRunAccepted, publishAgentRunSettled } from './agent-collaboration-lifecycle'

const sessions = new Map<string, AgentSessionMeta>()
const transcripts = new Map<string, SDKMessage[]>()
const callbacks = new Map<string, HeadlessAgentRunCallbacks[]>()
const generations = new Map<string, number>()
let failInitialization = false
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: (id: string) => sessions.get(id),
  listAgentSessions: () => [...sessions.values()],
  getAgentSessionSDKMessages: (id: string) => transcripts.get(id) ?? [],
  updateAgentSessionMeta: (id: string, update: Partial<AgentSessionMeta>) => {
    const next = { ...sessions.get(id)!, ...update }
    sessions.set(id, next)
    return next
  },
  createAgentSession: (title: string, channelId: string, _workspaceId?: string, modelId?: string) => {
    const meta: AgentSessionMeta = { id: randomUUID(), title, channelId, modelId, createdAt: 1, updatedAt: 1 }
    sessions.set(meta.id, meta)
    return meta
  },
}))
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: ({ modelId }: { modelId?: string }) => modelId,
  listEnabledAgentModelsForChannel: () => ({ models: [] }),
}))
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: async (input: { sessionId: string; startedAt: number }, cb: HeadlessAgentRunCallbacks) => {
    if (failInitialization) throw new Error('runner init failed')
    callbacks.set(input.sessionId, [...(callbacks.get(input.sessionId) ?? []), cb])
    const generation = (generations.get(input.sessionId) ?? 0) + 1
    generations.set(input.sessionId, generation)
    publishAgentRunAccepted(input.sessionId, { runGeneration: generation, startedAt: input.startedAt })
  },
  stopRegisteredAgent: () => {},
}))

mock.module('./agent-runtime-client', () => ({ AgentRuntimeClient: class {
  setRequestHandler(): void {}
  onEvent(): () => void { return () => {} }
  async call(): Promise<{ accepted: boolean }> { return { accepted: true } }
  async stop(): Promise<void> {}
} }))
interface TestTool {
  name: string
  parameters: TSchema
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }>
}
interface Summary {
  delegationId: string
  attemptId?: string
  childSessionId: string
  status: string
  error?: string
  resultSummary?: string
  resultAvailable?: boolean
  resultSummaryChars?: number
  startedAt: number
}
interface Result {
  delegations?: Summary[]
  delegation?: Summary
  status?: string
  note?: string
  completedCount?: number
  collaborationReceipts?: string[]
  totalCount?: number
  nextCursor?: string
  scope?: string
}
let build: typeof import('./agent-collaboration-tools').buildPiCollaborationTools
beforeAll(async () => {
  const module = await import('./agent-collaboration-tools')
  module.registerCollaborationLifecycle()
  build = module.buildPiCollaborationTools
})
function tools(parent = randomUUID()) {
  const sdk = { defineTool: (tool: TestTool) => tool } as unknown as typeof import('@earendil-works/pi-coding-agent')
  const definitions = build(sdk, { sessionId: parent, channelId: 'test', modelId: 'model', workspaceId: 'fixture' }).tools as TestTool[]
  return async (name: string, params: unknown, signal?: AbortSignal, callId = randomUUID()): Promise<Result> => {
    const result = await definitions.find((tool) => tool.name === `mcp__collaboration__${name}`)!.execute(callId, params, signal)
    return JSON.parse(result.content[0]!.text) as Result
  }
}
function emitStart(id: string, generation: number) {
  generations.set(id, generation)
  publishAgentRunAccepted(id, { runGeneration: generation, startedAt: 100 })
}
function emitEnd(id: string, generation: number, result: Parameters<typeof publishAgentRunSettled>[2]) {
  publishAgentRunSettled(id, { runGeneration: generation, startedAt: 100 }, result)
}
function transcript(id: string, uuid: string, text: string) {
  transcripts.set(id, [...(transcripts.get(id) ?? []), { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } } as unknown as SDKMessage])
}
async function create(call: ReturnType<typeof tools>): Promise<Summary> {
  const result = await call('delegate_agent', { title: 'Test', task: 'Offline fixture' })
  return result.delegation!
}

describe('协作工具真实状态链路（纯内存）', () => {
  test('Given 续跑已接受但未结束 When 调用continue Then 立即确认且重放同ID不重复启动', async () => {
    const call = tools()
    const child = await create(call)
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })
    const id = randomUUID()
    const pending = call('continue_delegation', { delegationId: child.delegationId, message: '下一轮' }, undefined, id)
    const early = await Promise.race([pending, new Promise<'not-returned'>((resolve) => setTimeout(() => resolve('not-returned'), 20))])
    // 无论红灯还是绿灯都结束合成运行，避免遗留一小时timer。
    emitEnd(child.childSessionId, 2, { resultSubtype: 'success' })
    await pending
    expect(early).not.toBe('not-returned')
    await call('continue_delegation', { delegationId: child.delegationId, message: '下一轮' }, undefined, id)
    expect(generations.get(child.childSessionId)).toBe(2)
    const newRun = await call('continue_delegation', { delegationId: child.delegationId, message: '第三轮' })
    expect(newRun.delegation?.status).toBe('running')
    emitEnd(child.childSessionId, 3, { resultSubtype: 'success' })
  })
  test('Given attempt 与结果预算 When get/list Then 返回 attemptId、凭据、metadata 与分页', async () => {
    const parent = randomUUID()
    const call = tools(parent)
    const first = await create(call)
    const second = await create(call)
    let result = await call('get_delegation_results', { delegationIds: [first.delegationId] })
    expect(result.delegations?.[0]?.attemptId).toBeString()
    expect(result.collaborationReceipts).toEqual([])
    expect(result.delegations?.[0]?.resultSummary).toBeUndefined()

    transcript(first.childSessionId, 'final', 'FINAL RESULT')
    emitEnd(first.childSessionId, 1, { resultSubtype: 'success', finalAssistantUuid: 'final' })
    result = await call('get_delegation_results', { delegationIds: [first.delegationId] })
    expect(result.collaborationReceipts).toEqual([result.delegations![0]!.attemptId!])
    expect(result.delegations?.[0]?.resultSummary).toBe('FINAL RESULT')

    const metadata = await call('get_delegation_results', {
      delegationIds: [first.delegationId],
      detail: 'preview',
      maxResultChars: 0,
    })
    // preview 预算 0 时正文为空但结果仍标记 available。
    expect(metadata.delegations?.[0]?.resultSummary).toBe('')
    expect(metadata.delegations?.[0]?.resultAvailable).toBe(true)
    expect(metadata.delegations?.[0]?.resultSummaryChars).toBe('FINAL RESULT'.length)
    await expect(call('get_delegation_results', {
      delegationIds: [first.delegationId, second.delegationId],
      detail: 'full',
    })).rejects.toThrow('detail=full')

    const current = await call('list_delegations', { scope: 'current', limit: 1 })
    expect(current.scope).toBe('current')
    expect(current.totalCount).toBe(2)
    expect(current.nextCursor).toBeString()
    const next = await call('list_delegations', {
      scope: 'current',
      limit: 1,
      cursor: current.nextCursor,
    })
    expect(next.delegations).toHaveLength(1)
    expect(next.nextCursor).toBeNull()
    expect(current.delegations?.[0]?.resultSummary).toBeUndefined()

    const history = await call('list_delegations', { scope: 'history' })
    expect(history.totalCount).toBe(2)
    emitEnd(second.childSessionId, 1, { resultSubtype: 'success' })
  })
  test('Given 运行中的委派 When boundary checkOnly Then pending；结束后投递结果', async () => {
    const parent = randomUUID()
    const call = tools(parent)
    const child = await create(call)
    const { createCollaborationBoundary } = await import('./agent-collaboration-tools')
    const boundary = createCollaborationBoundary(parent)
    const controller = new AbortController()

    expect((await boundary({ receipts: [], timeoutSeconds: 0, checkOnly: true }, controller.signal)).pending).toBe(true)
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })

    const result = await boundary({ receipts: [], timeoutSeconds: 1 }, controller.signal)
    expect(result.pending).toBe(false)
    expect(result.delivery?.text).toContain(child.delegationId)
  })
  test('Given 父等待取消 When 子任务仍在运行 Then 快速解除等待且不停止子任务', async () => {
    const call = tools()
    const child = await create(call)
    const controller = new AbortController()
    const wait = call('wait_for_delegations', { delegationIds: [child.delegationId], timeoutSeconds: 0.2 }, controller.signal).then(() => 'resolved', (error: Error) => error.name)
    controller.abort()
    const result = await Promise.race([wait, new Promise<'not-cancelled'>((resolve) => setTimeout(() => resolve('not-cancelled'), 20))])
    const state = await call('get_delegation_results', { delegationIds: [child.delegationId] })
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })
    await wait
    expect(result).toBe('AbortError')
    expect(state.delegations?.[0]?.status).toBe('running')
  })
  test('Given 模型schema When 省略/null/空白 Then 继承有明确定义且拒绝空字符串', async () => {
    const sdk = { defineTool: (tool: TestTool) => tool } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const definitions = build(sdk, { sessionId: randomUUID(), channelId: 'test', modelId: 'model', workspaceId: 'fixture' }).tools as TestTool[]
    for (const name of ['delegate_agent', 'delegate_agents']) {
      const schema = definitions.find((tool) => tool.name.endsWith(`__${name}`))!.parameters
      const args = (modelId: string | null | undefined) => {
        const item = { title: 'test', task: 'test', ...(modelId === undefined ? {} : { modelId }) }
        return name === 'delegate_agent' ? item : { items: [item] }
      }
      for (const value of [undefined, null, 'valid-id']) expect(Check(schema, args(value))).toBe(true)
      for (const value of ['', '   ']) expect(Check(schema, args(value))).toBe(false)
    }
    const child = (await tools()('delegate_agent', { title: 'test', task: 'offline', modelId: null })).delegation!
    expect(sessions.get(child.childSessionId)?.modelId).toBe('model')
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })
  })
  test('Given capability取消跨主进程适配器 When wait处于真实协作handler Then 释放等待且子任务仍运行', async () => {
    const { PiUtilityAdapter } = await import('./adapters/pi-utility-adapter')
    const parent = randomUUID(), call = tools(parent), child = await create(call)
    const sdk = { defineTool: (tool: TestTool) => tool } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const adapter = new PiUtilityAdapter()
    const input: PiAgentQueryOptions = {
      sessionId: parent, prompt: 'fixture', apiKey: 'fake', provider: 'custom', permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
      customTools: build(sdk, { sessionId: parent, channelId: 'test', modelId: 'model', workspaceId: 'fixture' }).tools as PiAgentQueryOptions['customTools'],
    }
    const iterator = adapter.query(input)[Symbol.asyncIterator]()
    const next = iterator.next().catch(() => undefined)
    // 此处只读当前合成query身份以发送真实protocol envelope，无Electron/真实配置。
    const pending = (adapter as unknown as { pendingQueries: Map<string, unknown> }).pendingQueries
    const queryId = [...pending.keys()][0]!
    const request = createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { queryId, toolName: 'mcp__collaboration__wait_for_delegations', toolCallId: 'wait-id', input: { delegationIds: [child.delegationId], timeoutSeconds: 3600 } })
    const wait = adapter.handleRuntimeRequest(request).catch((error: Error) => error.name)
    await adapter.handleRuntimeRequest(createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL, { requestId: request.requestId }))
    expect(await wait).toBe('AbortError')
    expect((adapter as unknown as { capabilityAbortControllers: Map<string, unknown> }).capabilityAbortControllers.size).toBe(0)
    expect((await call('get_delegation_results', { delegationIds: [child.delegationId] })).delegations?.[0]?.status).toBe('running')
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })
    adapter.dispose()
    await next
  })
  test('Given 配额失败 When 界面手动继续 Then running 清旧错误，完成只返回新结果', async () => {
    const call = tools()
    const child = await create(call)
    emitEnd(child.childSessionId, 1, { error: 'quota' })
    transcript(child.childSessionId, 'old', 'OLD ERROR')
    emitStart(child.childSessionId, 2)
    let result = await call('get_delegation_results', { delegationIds: [child.delegationId] })
    expect(result.delegations?.[0]).toMatchObject({ status: 'running' })
    expect(result.delegations?.[0]?.error).toBeNull()
    transcript(child.childSessionId, 'new', 'NEW FINAL')
    emitEnd(child.childSessionId, 2, { resultSubtype: 'success', finalAssistantUuid: 'new' })
    result = await call('get_delegation_results', { delegationIds: [child.delegationId] })
    expect(result.delegations?.[0]).toMatchObject({ status: 'completed', resultSummary: 'NEW FINAL' })
    expect(sessions.get(child.childSessionId)?.delegationStatus).toBe('completed')
  })
  test('Given 工具续跑 When 旧回调和旧终态迟到 Then 不覆盖新轮，wait 等待最新轮', async () => {
    const call = tools()
    const child = await create(call)
    const old = callbacks.get(child.childSessionId)![0]!
    const wait = call('wait_for_delegations', { delegationIds: [child.delegationId, child.delegationId], timeoutSeconds: 0.5 })
    emitEnd(child.childSessionId, 1, { error: 'timeout' })
    const continuing = call('continue_delegation', { delegationId: child.delegationId, message: '继续' })
    old.onError('OLD ERROR')
    old.onComplete()
    emitEnd(child.childSessionId, 1, { resultSubtype: 'success' })
    const running = await call('get_delegation_results', { delegationIds: [child.delegationId] })
    expect(running.delegations?.[0]?.status).toBe('running')
    transcript(child.childSessionId, 'last', 'LATEST')
    emitEnd(child.childSessionId, 2, { resultSubtype: 'success', finalAssistantUuid: 'last' })
    const [waited, continued] = await Promise.all([wait, continuing])
    expect(continued.delegation?.status).toBe('running') // 启动确认，不等待最终结果
    // 同一同步片段中的 finish→begin 不应该给 waiter 返回旧失败。
    expect(waited.status).toBe('completed')
    expect(waited.note).toBeNull()
    expect(waited.completedCount).toBe(1)
  })
  test('Given 无内存记录 When 重启后查询和手动续跑 Then list/get 一致并恢复新代际', async () => {
    const parent = randomUUID(), id = randomUUID(), delegationId = randomUUID()
    sessions.set(id, { id, title: 'Recovered', channelId: 'test', parentSessionId: parent, sourceDelegationId: delegationId, delegationStatus: 'running', delegationRunGeneration: 8, createdAt: 1, updatedAt: 2 })
    const call = tools(parent)
    expect((await call('list_delegations', {})).delegations?.[0]?.status).toBe('interrupted')
    expect((await call('get_delegation_results', { delegationIds: [delegationId] })).delegations?.[0]?.status).toBe('interrupted')
    emitStart(id, 9)
    expect((await call('list_delegations', {})).delegations?.[0]?.status).toBe('running')
    emitEnd(id, 9, { stoppedByUser: true })
    expect((await call('get_delegation_results', { delegationIds: [delegationId] })).delegations?.[0]?.status).toBe('cancelled')
  })
  test('Given 旧meta缺父归属但已唯一恢复 When 续跑成功 Then 接受新代际不兜底误报失败', async () => {
    const parent = randomUUID(), id = randomUUID(), delegationId = randomUUID()
    sessions.set(id, { id, title: 'Legacy', channelId: 'test', sourceDelegationId: delegationId, delegationStatus: 'completed', delegationRunGeneration: 4, createdAt: 1, updatedAt: 2 })
    generations.set(id, 4)
    const call = tools(parent)
    await call('continue_delegation', { delegationId, message: 'continue legacy' })
    transcript(id, 'legacy-final', 'new success')
    emitEnd(id, 5, { resultSubtype: 'success', finalAssistantUuid: 'legacy-final' })
    callbacks.get(id)!.at(-1)!.onComplete()
    const result = (await call('get_delegation_results', { delegationIds: [delegationId] })).delegations![0]!
    expect(result.status).toBe('completed')
    expect(result.resultSummary).toBe('new success')
    expect(sessions.get(id)?.delegationRunGeneration).toBe(5)
  })
  test('Given 已终结状态矩阵 When 手动继续 Then 无正文不借用旧答案，错误 subtype 不误报成功', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
      const parent = randomUUID(), id = randomUUID(), delegationId = randomUUID()
      sessions.set(id, { id, title: status, channelId: 'test', parentSessionId: parent, sourceDelegationId: delegationId, delegationStatus: status, createdAt: 1, updatedAt: 2 })
      transcript(id, 'old', 'OLD ANSWER')
      const call = tools(parent)
      emitStart(id, 1)
      emitEnd(id, 1, { resultSubtype: 'error_max_budget_usd' })
      const result = (await call('get_delegation_results', { delegationIds: [delegationId] })).delegations![0]!
      expect(result.status).toBe('failed')
      expect(result.resultSummary).not.toContain('OLD ANSWER')
    }
  })
  test('Given waiter 目标被保留上限清理 When 恢复续跑 Then 每次按ID读取最新record', async () => {
    const call = tools()
    const a = await create(call), b = await create(call)
    const wait = call('wait_for_delegations', { delegationIds: [a.delegationId, b.delegationId], timeoutSeconds: 1 })
    emitEnd(a.childSessionId, 1, { stoppedByUser: true })
    // 官方 scope 单轮上限 128 次执行；保留上限是全局的，用多个父会话分摊压力。
    const overflowCalls = [tools(), tools(), tools(), tools()]
    for (let index = 0; index < 202; index++) {
      const item = await create(overflowCalls[Math.floor(index / 64)]!)
      emitEnd(item.childSessionId, 1, { resultSubtype: 'success' })
    }
    emitStart(a.childSessionId, 2)
    emitEnd(b.childSessionId, 1, { resultSubtype: 'success' })
    let resolved = false
    void wait.then(() => { resolved = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(resolved).toBe(false)
    emitEnd(a.childSessionId, 2, { resultSubtype: 'success' })
    expect((await wait).delegations?.find((item) => item.delegationId === a.delegationId)?.status).toBe('completed')
  })
  test('Given runner 未初始化 When 启动失败 Then 兜底失败并拒绝跨父会话读取', async () => {
    failInitialization = true
    try {
      const call = tools(), other = tools()
      const child = await create(call)
      await Promise.resolve()
      const result = await call('wait_for_delegations', { delegationIds: [child.delegationId], timeoutSeconds: 0.1 })
      expect(result.delegations?.[0]?.status).toBe('failed')
      await expect(other('get_delegation_results', { delegationIds: [child.delegationId] })).rejects.toThrow('不属于')
    } finally { failInitialization = false }
  })
})
