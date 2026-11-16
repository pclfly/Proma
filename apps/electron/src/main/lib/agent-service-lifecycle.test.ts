import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { BrowserWindow, WebContents } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type { AgentSendInput } from '@proma/shared'
import type { AgentOrchestrator } from './agent-orchestrator'
import { setMainWindow } from './main-window-store'
import { AgentQueryDrain } from './agent-query-drain'
import { createPiSessionCleanup } from './adapters/pi-session-cleanup'

interface SentMessage { channel: string; payload: unknown }
interface RendererFixture { wc: WebContents; window: BrowserWindow; sent: SentMessage[]; destroy(): void }
function renderer(name: string, onSend?: (channel: string) => void): RendererFixture {
  let destroyed = false
  const sent: SentMessage[] = []
  const wc = {
    isDestroyed: () => destroyed,
    getURL: () => `http://localhost/?window=${name}`,
    once: () => {},
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); onSend?.(channel) },
  } as unknown as WebContents
  return { wc, window: { isDestroyed: () => destroyed, webContents: wc } as BrowserWindow, sent, destroy: () => { destroyed = true } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type RunCallbacks = Parameters<AgentOrchestrator['sendMessage']>[1]
const active = new Set<string>()
const starts: string[] = []
const stoppedBeforeRun = new Set<string>()
const cleanupBlocked = new Set<string>()
const stopCalls: Array<{ id: string; before: boolean }> = []
const bodies = new Map<string, (input: AgentSendInput, callbacks: RunCallbacks) => Promise<void>>()
let windows: BrowserWindow[] = []
let generation = 0
mock.module('electron', () => ({ BrowserWindow: { getAllWindows: () => windows } }))
mock.module('./adapters/pi-agent-adapter', () => ({ PiAgentAdapter: class {} }))
mock.module('./adapters/pi-utility-adapter', () => ({ PiUtilityAdapter: class {} }))
mock.module('./agent-orchestrator', () => ({ AgentOrchestrator: class {
  isActive(id: string) { return active.has(id) }
  hasActiveSessions() { return active.size > 0 || cleanupBlocked.size > 0 }
  isRunCleanupBlocked(id: string) { return cleanupBlocked.has(id) }
  listActiveSessionSnapshots() { return [...active].map(sessionId => ({ sessionId })) }
  reserveRunGeneration() { return ++generation }
  async sendMessage(input: AgentSendInput & { runGeneration?: number; cancelledBeforeStart?: boolean }, callbacks: RunCallbacks) {
    const runGeneration = input.runGeneration ?? ++generation
    const preStopped = stoppedBeforeRun.delete(input.sessionId)
    if (input.cancelledBeforeStart || preStopped) {
      callbacks.onComplete([], { stoppedByUser: true, startedAt: Date.now(), runGeneration })
      return // 真实预检早停不发 onRunStarted，也不创建 query。
    }
    starts.push(input.sessionId)
    active.add(input.sessionId)
    callbacks.onRunStarted?.({ startedAt: Date.now(), runGeneration })
    try { await bodies.get(input.sessionId)?.(input, callbacks) } finally { active.delete(input.sessionId) }
  }
  async stop(id: string, before = false) {
    stopCalls.push({ id, before })
    if (!active.has(id) && before) stoppedBeforeRun.add(id)
    active.delete(id)
  }
  async stopAndDrain(id: string) { active.delete(id) }
  clearStoppedBeforeRun(id: string) { stoppedBeforeRun.delete(id) }
  stopAll() { active.clear() }
} }))
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: () => undefined, updateAgentSessionMeta: () => {}, markAgentSessionDeleting: () => {},
  isAgentSessionDeleting: () => false,
}))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBySlug: () => undefined,
  getProjectFilesPath: () => '/fixture',
  // 来源归因现在先验证注册表；fixture 提供确定的工作区记录与只读项目根。
  getKnownKnowledgeWorkspace: (slug: string) => ({ id: slug, slug, name: slug, createdAt: 1, updatedAt: 1 }),
  resolveWorkspaceProjectRoot: () => '/fixture',
  getWorkspaceKnowledgePolicy: (slug: string) => ({ anchor: `/fixture-workspaces/${slug}`, logicalRoot: `/fixture-workspaces/${slug}/memory`, authorizedDirectories: [] }),
  // 测试未授权 AGENTS 自动展示：来源归因只保留竞争目标。
  isWorkspaceProjectKnowledgeMaintenanceApproved: () => false,
}))
mock.module('./project-root-health', () => ({ getLocalProjectRootStatus: () => 'managed' }))
mock.module('./config-paths', () => ({
  getAgentSessionWorkspacePath: () => '/fixture',
  // 来源归因运行时只计算路径；测试不创建真实工作区目录。
  resolveAgentWorkspaceDirPath: (slug: string) => `/fixture-workspaces/${slug}`,
}))
mock.module('./agent-collaboration-tools', () => ({ registerCollaborationEventBus: () => {}, registerCollaborationLifecycle: () => {} }))
const service = await import('./agent-service')
const headlessCallbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }
const input = (sessionId: string): AgentSendInput => ({ sessionId, channelId: 'fixture', userMessage: '合成测试' })
afterEach(() => {
  setMainWindow(null); windows = []; bodies.clear(); starts.length = 0; active.clear()
  stoppedBeforeRun.clear(); cleanupBlocked.clear(); stopCalls.length = 0
})

describe('Agent 服务真实包装的窗口与收尾', () => {
  for (const kind of ['desktop', 'headless', 'queued'] as const) {
    test(`Given ${kind}首轮已发完成但finally仍等待 When 入队并唤醒 Then 真正收尾后只派发一次`, async () => {
      const main = renderer('main')
      setMainWindow(main.window)
      const sessionId = `drain-${kind}`
      const terminal = deferred()
      const cleanup = deferred()
      let invocation = 0
      bodies.set(sessionId, async (_, callbacks) => {
        const closeSession = createPiSessionCleanup({
          waitForProducer: async () => {}, dispose: () => {},
          closeDispatcher: () => cleanup.promise, release: () => {},
        })
        const query = new AgentQueryDrain({ async *[Symbol.asyncIterator]() {
          try { yield 'terminal' } finally { await closeSession() }
        } }, () => {})
        await query.next()
        active.delete(sessionId)
        callbacks.onComplete([], { runGeneration: generation })
        if (++invocation === 1) terminal.resolve()
        await query.close() // 使用生产 query/dispatcher 屏障组合，而不是仅假设外壳等待。
      })
      let run: Promise<void> | undefined
      if (kind === 'desktop') run = service.runAgent(input(sessionId), main.wc)
      else if (kind === 'headless') run = service.runAgentHeadless(input(sessionId), headlessCallbacks)
      else service.enqueueAgentQueuedMessage({ ...input(sessionId), queueMessageId: 'first' }, main.wc)
      await terminal.promise
      try {
        service.enqueueAgentQueuedMessage({ ...input(sessionId), queueMessageId: 'second' }, main.wc)
        service.setVisibleAgentSession(main.wc, sessionId)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(starts).toEqual([sessionId])
        expect(service.isAgentSessionBusy(sessionId)).toBe(true)
      } finally { cleanup.resolve(); await run }
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(starts).toEqual([sessionId, sessionId])
      expect(service.listQueuedAgentMessages(sessionId)).toEqual([])
    })
  }
  test('Given 镜像准备已占启动槽位 When 队列和headless进入 Then 不抢先运行且释放槽位后唤醒', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const release = service.reserveAgentSessionStart('mirror')
    service.enqueueAgentQueuedMessage({ ...input('mirror'), queueMessageId: 'waiting' }, main.wc)
    await expect(service.runAgentHeadless(input('mirror'), headlessCallbacks)).rejects.toThrow('正在启动')
    expect(starts).toEqual([])
    release()
    release() // 旧release幂等，不能删除未来的槽位。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(starts).toEqual(['mirror'])
  })

  test('Given 镜像期间已停止 When 原SEND到达且预检早停 Then 不能二次恢复待发队列', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const id = 'mirror-stop'
    const release = service.reserveAgentSessionStart(id)
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'B' }, main.wc)
    service.stopAgent(id)
    await service.runAgent(input(id), main.wc)
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(starts).toEqual([])
    expect(service.listQueuedAgentMessages(id).map(item => item.input.queueMessageId)).toEqual(['B'])
  })

  test('Given headless刚占槽未进入body When 同调用栈停止 Then 早停完成且不创建query', async () => {
    const onComplete = mock((_messages: unknown, _options: unknown) => {})
    const run = service.runAgentHeadless(input('headless-pre-stop'), { ...headlessCallbacks, onComplete })
    service.stopAgent('headless-pre-stop')
    await run
    expect(starts).toEqual([])
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0]?.[1]).toMatchObject({ stoppedByUser: true })
  })

  test('Given queued已终态但仍在清理 When stop后显式提升 Then 不将旧停止标记留给下一轮', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const id = 'terminal-stop'
    const terminal = deferred(), cleanup = deferred()
    let invocation = 0
    bodies.set(id, async (_, callbacks) => {
      active.delete(id)
      callbacks.onComplete([], { runGeneration: generation })
      if (++invocation === 1) { terminal.resolve(); await cleanup.promise }
    })
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'A' }, main.wc)
    await terminal.promise
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'B' }, main.wc)
    service.stopAgent(id)
    cleanup.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await service.promoteAgentQueuedMessage({ sessionId: id, messageId: 'B', interrupt: false }, main.wc)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stopCalls.at(-1)?.before).toBe(false)
    expect(starts).toEqual([id, id])
  })

  test('Given 已接受queued尚未进入body When 立即停止 Then 取消只针对本条且显式新输入可启动', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const id = 'queued-pre-stop'
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'A' }, main.wc)
    service.stopAgent(id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(starts).toEqual([])
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'B' }, main.wc)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(starts).toEqual([id])
  })

  test('Given 镜像请求被停止后放弃 When 槽位释放并显式新发 Then 不留下跨轮取消标记', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const id = 'mirror-abandoned'
    const release = service.reserveAgentSessionStart(id)
    service.stopAgent(id)
    release()
    await service.runAgent(input(id), main.wc)
    expect(starts).toEqual([id])
  })

  test('Given headless续跑等待旧drain When 期间再次停止 Then 等待结束也不自动恢复', async () => {
    const id = 'continue-stop'
    const terminal = deferred(), cleanup = deferred()
    bodies.set(id, async (_, callbacks) => {
      active.delete(id); callbacks.onComplete([], {})
      terminal.resolve(); await cleanup.promise
    })
    const first = service.runAgentHeadless(input(id), headlessCallbacks)
    await terminal.promise
    const onComplete = mock((_messages: unknown, _options: unknown) => {})
    const second = service.runAgentHeadless(input(id), { ...headlessCallbacks, onComplete })
    service.stopAgent(id)
    cleanup.resolve()
    await Promise.all([first, second])
    expect(starts).toEqual([id])
    expect(onComplete.mock.calls[0]?.[1]).toMatchObject({ stoppedByUser: true })
  })

  test('Given 清理最终失败 When 队列唤醒和删除等待结束 Then 保留消息且禁止新运行与删除', async () => {
    const main = renderer('main')
    setMainWindow(main.window)
    const id = 'cleanup-blocked'
    const terminal = deferred(), cleanup = deferred()
    bodies.set(id, async (_, callbacks) => {
      const query = new AgentQueryDrain({ [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: 'terminal' }),
        return: async () => { await cleanup.promise; throw new Error('清理失败') },
      }) }, () => {})
      await query.next()
      active.delete(id); callbacks.onComplete([], {}); terminal.resolve()
      try { await query.close() } catch (error) {
        cleanupBlocked.add(id) // 对应真实 orchestrator.closeQueryAttempt，另有实际方法回归。
        callbacks.onError((error as Error).message)
      }
    })
    const first = service.runAgent(input(id), main.wc)
    await terminal.promise
    service.enqueueAgentQueuedMessage({ ...input(id), queueMessageId: 'waiting' }, main.wc)
    const deleting = service.stopAgentAndDrain(id)
    void deleting.catch(() => {}) // 先登记拒绝处理；Bun matcher 要在放行 deferred 后再求值。
    cleanup.resolve()
    await first
    await expect(deleting).rejects.toThrow('安全收尾')
    service.setVisibleAgentSession(main.wc, id)
    expect(starts).toEqual([id])
    expect(service.listQueuedAgentMessages(id).map(item => item.input.queueMessageId)).toEqual(['waiting'])
    expect(service.isAgentSessionBusy(id)).toBe(true)
    expect(() => service.runAgent(input(id), main.wc)).toThrow('安全收尾')
    await expect(service.runAgentHeadless(input(id), headlessCallbacks)).rejects.toThrow('安全收尾')
  })

  test('Given headless旧轮已业务完成 When 合法续跑立即进入 Then 等完整finally且只接受一轮', async () => {
    const terminal = deferred()
    const cleanup = deferred()
    let invocation = 0
    bodies.set('continue', async (_, callbacks) => {
      active.delete('continue')
      callbacks.onComplete([], {})
      if (++invocation === 1) { terminal.resolve(); await cleanup.promise }
    })
    const first = service.runAgentHeadless(input('continue'), headlessCallbacks)
    await terminal.promise
    const second = service.runAgentHeadless(input('continue'), headlessCallbacks)
    await Promise.resolve()
    expect(starts).toEqual(['continue'])
    cleanup.resolve()
    await Promise.all([first, second])
    expect(starts).toEqual(['continue', 'continue'])
  })

  test('Given 队列started刚发送 When 主窗口在run微任务前消失 Then 已接受消息仍执行一次而不丢失', async () => {
    const main = renderer('main', channel => {
      if (channel === AGENT_IPC_CHANNELS.QUEUED_MESSAGE_STATUS) { main.destroy(); setMainWindow(null) }
    })
    setMainWindow(main.window)
    service.enqueueAgentQueuedMessage({ ...input('accepted-before-close'), queueMessageId: 'a' }, main.wc)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(main.wc.isDestroyed()).toBe(true)
    expect(starts).toEqual(['accepted-before-close'])
    expect(service.listQueuedAgentMessages('accepted-before-close')).toEqual([])
  })

  test('Given 辅助窗在枚举中排第一 When headless运行 Then 只向登记的主窗口输出', async () => {
    const aux = renderer('workspace-memory')
    const main = renderer('main')
    windows = [aux.window, main.window]
    setMainWindow(main.window)
    bodies.set('route-main', async (_, callbacks) => { callbacks.onComplete([], { runGeneration: generation }) })
    await service.runAgentHeadless(input('route-main'), headlessCallbacks)
    expect(aux.sent).toEqual([])
    expect(main.sent.some(item => item.channel.includes('stream'))).toBe(true)
  })

  test('Given 没有登记主窗口但辅助窗存活 When headless运行 Then 不向辅助窗回退', async () => {
    const aux = renderer('workspace-memory')
    windows = [aux.window]
    bodies.set('route-no-main', async (_, callbacks) => { callbacks.onComplete([], {}) })
    await service.runAgentHeadless(input('route-no-main'), headlessCallbacks)
    expect(aux.sent).toEqual([])
  })

  test('Given headless无窗启动 When 主窗在运行中恢复 Then 终态投递且原owner负责清理', async () => {
    const entered = deferred()
    const finish = deferred()
    bodies.set('route-late-main', async (_, callbacks) => {
      entered.resolve()
      await finish.promise
      active.delete('route-late-main')
      callbacks.onComplete([], {})
    })
    const run = service.runAgentHeadless(input('route-late-main'), headlessCallbacks)
    await entered.promise
    const main = renderer('main')
    setMainWindow(main.window)
    service.setVisibleAgentSession(main.wc, 'route-late-main')
    finish.resolve()
    await run
    expect(main.sent.some(item => item.channel === 'agent:stream:complete')).toBe(true)
    const count = main.sent.length
    service.agentEventBus.emit('route-late-main', { kind: 'proma_event', event: { type: 'title_updated', title: '迟到事件' } })
    expect(main.sent.length).toBe(count)
  })

  test('Given 主窗口运行中 When 辅助窗请求重绑 Then 拒绝且不夺取流目标', async () => {
    const main = renderer('main')
    const aux = renderer('workspace-memory')
    setMainWindow(main.window)
    const entered = deferred()
    const finish = deferred()
    bodies.set('route-rebind', async () => { entered.resolve(); await finish.promise })
    const run = service.runAgent(input('route-rebind'), main.wc)
    await entered.promise
    try {
      expect(() => service.setVisibleAgentSession(aux.wc, 'route-rebind')).toThrow()
      service.agentEventBus.emit('route-rebind', { kind: 'proma_event', event: { type: 'title_updated', title: '只给主窗' } })
      expect(aux.sent).toEqual([])
    } finally { finish.resolve(); await run }
  })

  test('Given headless已接受但未进入body When 应用退出 Then 发送取消终态且不初始化query', async () => {
    const onComplete = mock((_messages: unknown, _options: unknown) => {})
    const run = service.runAgentHeadless(input('shutdown-pre-body'), { ...headlessCallbacks, onComplete })
    service.stopAllAgents()
    await run
    expect(starts).toEqual([])
    expect(onComplete.mock.calls[0]?.[1]).toMatchObject({ stoppedByUser: true })
  })
})
