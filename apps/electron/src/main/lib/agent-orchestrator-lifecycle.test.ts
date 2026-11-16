import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AgentQueryDrain, AgentQueryDrainError } from './agent-query-drain'
import type { SDKMessage } from '@proma/shared'
import { getActiveAgentRun, onAgentRunLifecycle, publishAgentRunAccepted, type AgentRunLifecycleEvent } from './agent-collaboration-lifecycle'

// 仅替换编排器的外部服务；实际 sendMessage wrapper / 预检 / stop 都从源码加载。
// 不导入 Electron 服务、用户配置或真实模型 provider。
const persistedGenerations = new Map<string, number>()
let releasePreflight: (() => void) | undefined
const workspaceReady = () => new Promise<'available'>((resolve) => { releasePreflight = () => resolve('available') })
const pendingPermissions = new Set<string>()
const pendingPlans = new Set<string>()
const overrides: Record<string, unknown> = {
  getAgentSessionMeta: (id: string) => ({ id, delegationRunGeneration: persistedGenerations.get(id), workspaceId: 'test', createdAt: 1, updatedAt: 1 }),
  isAgentSessionDeleting: () => false,
  updateAgentSessionMeta: () => ({}),
  appendSDKMessages: () => {},
  getVaultUserContext: () => undefined,
  getAgentWorkspace: () => ({ id: 'test', projectRootPath: 'fixture' }),
  getLocalProjectRootStatus: workspaceReady,
  getChannelById: () => undefined,
  browserController: { cancelSession: () => {} },
  permissionService: { clearSessionPending: (id: string) => pendingPermissions.delete(id) },
  exitPlanService: { clearSessionPending: (id: string) => pendingPlans.delete(id) },
}
const source = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')
// 纯函数模块没有外部副作用，保持真实实现：
// 若把它们也 mock 成 () => undefined，任何共享同一进程的其他测试都会拿到空壳。
const REAL_MODULES = new Set([
  './agent-collaboration-lifecycle',
  './agent-event-bus',
  './agent-send-message-policy',
  './agent-query-drain',
  './agent-partial-stop-persistence',
  './agent-turn-timing',
])
for (const match of source.matchAll(/import\s+(?!type\b)\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
  const [, bindings, path] = match
  if (!path?.startsWith('./') || REAL_MODULES.has(path)) continue
  const exports: Record<string, unknown> = {}
  for (const binding of bindings!.split(',')) {
    const name = binding.trim()
    if (!name || name.startsWith('type ')) continue
    exports[name] = overrides[name] ?? (() => undefined)
  }
  mock.module(path, () => exports)
}
mock.module('electron', () => ({ app: {} }))
mock.module('@proma/core', () => ({ getAdapter: () => undefined, fetchTitle: () => undefined }))
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
import type { AgentProviderAdapter } from '@proma/shared'
import type { SessionCallbacks } from './agent-orchestrator'
const adapter = { abort: () => {}, dispose: () => {} } as unknown as AgentProviderAdapter
const callbacks: SessionCallbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }

describe('编排器接受/预检生命周期', () => {
  test('Given 已接受请求携带本轮取消 When sendMessage进入 Then 预检前即结算且不发run_started', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID(), events: AgentRunLifecycleEvent[] = []
    const off = onAgentRunLifecycle(event => { if (event.sessionId === id) events.push(event) })
    const onRunStarted = mock(() => {})
    releasePreflight = undefined
    try {
      await orchestrator.sendMessage({ sessionId: id, channelId: 'missing', userMessage: '不初始化', cancelledBeforeStart: true }, { ...callbacks, onRunStarted })
      expect(releasePreflight).toBeUndefined()
      expect(onRunStarted).not.toHaveBeenCalled()
      expect(events).toHaveLength(2)
      expect(events[1]?.completion?.stoppedByUser).toBe(true)
      expect(orchestrator.isActive(id)).toBe(false)
    } finally { off() }
  })
  test('Given 适配器自然next携带清理失败 When 消费循环与attempt finally组合 Then 进入会话隔离而不是业务错误', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID()
    // 模拟 PiUtilityAdapter：query 自然结束后 finally 因无法确认运行时退出而抛出专用错误。
    const iterable = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success' } as SDKMessage
        throw new AgentQueryDrainError(new Error('无法确认 Agent 运行时进程已退出'))
      },
    }
    const drain = new AgentQueryDrain<SDKMessage>(iterable, () => {})
    let loopError: unknown
    try {
      while (true) {
        const result = await drain.next()
        if (result.done) break
      }
    } catch (error) { loopError = error }
    expect(loopError).toBeInstanceOf(AgentQueryDrainError)
    const closeAccess = orchestrator as unknown as {
      closeQueryAttempt(sessionId: string, drain: AgentQueryDrain<SDKMessage>): Promise<void>
    }
    await expect(closeAccess.closeQueryAttempt(id, drain)).rejects.toBeInstanceOf(AgentQueryDrainError)
    expect(orchestrator.isRunCleanupBlocked(id)).toBe(true)
    const onError = mock((_message: string) => {})
    await orchestrator.sendMessage({ sessionId: id, channelId: 'missing', userMessage: '不得续发' }, { ...callbacks, onError })
    expect(onError.mock.calls[0]?.[0]).toContain('安全收尾')
  })

  test('Given query清理失败 When 实际finally关闭入口执行 Then 只隔离本会话并拒绝新轮与删除', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID()
    const drain = new AgentQueryDrain<SDKMessage>({ [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: { type: 'result', subtype: 'success' } as SDKMessage }),
      return: async () => { throw new Error('无法确认运行时已关闭') },
    }) }, () => {})
    await drain.next()
    const closeAccess = orchestrator as unknown as {
      closeQueryAttempt(sessionId: string, drain: AgentQueryDrain<SDKMessage>): Promise<void>
    }
    await expect(closeAccess.closeQueryAttempt(id, drain)).rejects.toBeInstanceOf(AgentQueryDrainError)
    expect(orchestrator.isRunCleanupBlocked(id)).toBe(true)
    expect(orchestrator.isRunCleanupBlocked('other-session')).toBe(false)
    expect(orchestrator.hasActiveSessions()).toBe(true)
    const onError = mock((_message: string) => {})
    await orchestrator.sendMessage({ sessionId: id, channelId: 'missing', userMessage: '不应重放' }, { ...callbacks, onError })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toContain('安全收尾')
    expect(getActiveAgentRun(id)).toBeUndefined()
    await expect(orchestrator.stopAndDrain(id)).rejects.toBeInstanceOf(AgentQueryDrainError)
  })
  test('Given 异步预检 When 并发发送 Then 只接受一个代际，预检错误记为失败', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID(), events: AgentRunLifecycleEvent[] = []
    const off = onAgentRunLifecycle((event) => { if (event.sessionId === id) events.push(event) })
    persistedGenerations.set(id, 7)
    const input = { sessionId: id, channelId: 'missing', userMessage: '继续' }
    const run = orchestrator.sendMessage(input, callbacks)
    expect(getActiveAgentRun(id)?.runGeneration).toBe(8)
    await orchestrator.sendMessage(input, callbacks)
    expect(events).toHaveLength(1)
    releasePreflight!()
    await run
    expect(events).toHaveLength(2)
    expect(events[1]?.completion?.error).toContain('渠道')
    expect(orchestrator.isActive(id)).toBe(false)
    off()
  })
  test('Given g1迟到清理 When g2已请求权限/计划审批 Then 不清除g2请求', () => {
    // 执行源码中 finally 的真实清理片段，避免必须初始化模型/工具才能覆盖这一竞态。
    const block = source.match(/finally \{\s*\/\/ 只在 generation 匹配时才清理[\s\S]*?\n    \}/)?.[0]
    expect(block).toBeDefined()
    const cleanupBody = block!.slice(block!.indexOf('{') + 1, block!.lastIndexOf('}'))
    const cleanup = new Function('sessionId', 'runGeneration', 'releaseActiveRun', 'permissionService', 'exitPlanService', cleanupBody)
    const id = randomUUID()
    pendingPermissions.add(id)
    pendingPlans.add(id)
    const owner = { nextRunGenerationBySession: new Map([[id, 2]]) }
    cleanup.call(owner, id, 1, () => {}, overrides.permissionService, overrides.exitPlanService)
    expect(pendingPermissions.has(id)).toBe(true)
    expect(pendingPlans.has(id)).toBe(true)
    cleanup.call(owner, id, 2, () => {}, overrides.permissionService, overrides.exitPlanService)
    expect(pendingPermissions.has(id)).toBe(false)
    expect(pendingPlans.has(id)).toBe(false)
  })
  test('Given 预检期间停止并开始新轮 When 旧预检结束 Then 不能终结或抢占新代际', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID(), events: AgentRunLifecycleEvent[] = []
    const off = onAgentRunLifecycle((event) => { if (event.sessionId === id) events.push(event) })
    const input = { sessionId: id, channelId: 'missing', userMessage: '继续' }
    const first = orchestrator.sendMessage(input, callbacks)
    const releaseOld = releasePreflight!
    orchestrator.stop(id)
    expect(events[1]?.completion?.stoppedByUser).toBe(true)
    const second = orchestrator.sendMessage(input, callbacks)
    const releaseNew = releasePreflight!
    releaseOld()
    await first
    expect(getActiveAgentRun(id)?.runGeneration).toBe(2)
    expect(orchestrator.isActive(id)).toBe(true)
    expect(events).toHaveLength(3)
    releaseNew()
    await second
    expect(events).toHaveLength(4)
    expect(getActiveAgentRun(id)).toBeUndefined()
    off()
  })

  // 官方 0.21.92：网络未就绪时启动会话导致运行槽未释放，该会话后续消息被全部拒绝。
  // 根因是 stop() 在没有运行代际时也置位「预检前停止」标记，而该标记只在预检出口消费；
  // 若本轮在预检之前就失败，标记无人消费，会话被永久判定为已停止。
  test('Given 无运行代际时停止 When 该会话再次发送 Then 不会被残留停止标记静默吞掉', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID()
    // 复现「队列启动投影已显示、但运行槽尚未占用」：activeRun 存在而
    // runGeneration 为 undefined。修复前该组合会把会话标记为预检前停止。
    publishAgentRunAccepted(id, { startedAt: Date.now(), runGeneration: 99 })
    orchestrator.stop(id)
    const onError = mock((_message: string) => {})
    const onComplete = mock((_messages: unknown, opts?: { stoppedByUser?: boolean; error?: string }) => { void opts })
    const run = orchestrator.sendMessage(
      { sessionId: id, channelId: 'missing', userMessage: '继续' },
      { ...callbacks, onError, onComplete },
    )
    releasePreflight?.()
    releasePreflight = undefined
    await run
    // 被停止标记吞掉时只会以 stoppedByUser 静默收尾、不产生任何错误；
    // 真正进入本轮则会走到渠道预检并报错。
    const completion = onComplete.mock.calls[0]?.[1]
    expect(completion?.stoppedByUser).not.toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('Given 预检前停止标记 When 收尾清理后再发送 Then 新轮正常进入', async () => {
    const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
    const id = randomUUID()
    orchestrator.stop(id, true)
    // 收尾兜底由 agent-service 调用；这里验证清理入口本身能解除污染。
    orchestrator.clearStoppedBeforeRun(id)
    const onError = mock((_message: string) => {})
    const run = orchestrator.sendMessage(
      { sessionId: id, channelId: 'missing', userMessage: '继续' },
      { ...callbacks, onError },
    )
    releasePreflight?.()
    releasePreflight = undefined
    await run
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
