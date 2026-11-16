import { describe, expect, test, mock } from 'bun:test'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus } from '@proma/shared'
import type { WebContents } from 'electron'

interface Harness {
  coordinator: AgentQueueCoordinator
  isActive: (sessionId: string) => boolean
  setActive: (active: boolean) => void
  setBlocked: (blocked: boolean) => void
  restoreWebContents: () => void
  startRun: ReturnType<typeof mock>
  sendStarted: ReturnType<typeof mock>
  inject: ReturnType<typeof mock>
  enqueue: (sessionId: string, queueMessageId: string, text?: string) => void
  flushAsync: () => Promise<void>
  webContents: WebContents
  destroyWebContents: () => void
}

function createInput(sessionId: string, queueMessageId: string, text = 'hello'): AgentDeferredQueueMessageInput {
  return {
    sessionId,
    queueMessageId,
    userMessage: text,
    rawUserMessage: text,
    channelId: 'channel-1',
  } as AgentDeferredQueueMessageInput
}

function createHarness(options?: { active?: boolean }): Harness {
  let active = options?.active ?? false
  const webContents = { isDestroyed: () => false } as unknown as WebContents
  let destroyed = false
  let blocked = false
  const startRun = mock(() => Promise.resolve())
  const sendStarted = mock(() => {})
  const inject = mock(() => Promise.resolve(true))
  let runGeneration = 0

  const coordinator = new AgentQueueCoordinator({
    isActive: () => active,
    isStartBlocked: () => blocked,
    getWebContents: () => (destroyed ? null : webContents),
    startRun,
    sendStarted,
    reserveRunGeneration: () => ++runGeneration,
    inject,
  })

  return {
    coordinator,
    isActive: () => active,
    setActive: (next) => { active = next },
    setBlocked: (next) => { blocked = next },
    restoreWebContents: () => { destroyed = false },
    startRun,
    sendStarted,
    inject,
    enqueue: (sessionId, queueMessageId, text) => {
      coordinator.enqueue(createInput(sessionId, queueMessageId, text))
    },
    /** 官方 dispatch 链路经 Promise.resolve().then() 异步执行；断言前需 flush 微任务。 */
    flushAsync: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    webContents,
    destroyWebContents: () => { destroyed = true },
  }
}

describe('AgentQueueCoordinator.promote', () => {
  test('Given an empty queue When promoting a message Then returns not_found and does nothing', async () => {
    const h = createHarness()
    const result = await h.coordinator.promote('session-1', 'missing-id', false)
    expect(result).toBe('not_found')
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.sendStarted).not.toHaveBeenCalled()
  })

  test('Given an idle session When promoting a queued message Then dispatches a new run with started projection', async () => {
    const h = createHarness({ active: true })
    // 活跃时入队，消息停留在队列中等待当前 run 结束。
    h.enqueue('session-1', 'msg-1', 'hello')
    h.enqueue('session-1', 'msg-2', 'world')
    expect(h.startRun).not.toHaveBeenCalled()
    h.setActive(false)

    const result = await h.coordinator.promote('session-1', 'msg-1', false)
    expect(result).toBe('dispatched')
    await h.flushAsync()

    // 只派发被提升的消息；run 结束后官方语义会自动接续派发下一条，故 flush 后共 2 次。
    expect(h.startRun).toHaveBeenCalledTimes(2)
    expect(h.sendStarted).toHaveBeenCalledTimes(2)
    const status = h.sendStarted.mock.calls[0]?.[1] as AgentQueuedMessageStatus
    expect(status.messageId).toBe('msg-1')
    expect(status.sessionId).toBe('session-1')
    expect(typeof status.startedAt).toBe('number')
    expect(status.runGeneration).toBe(1)
    const runInput = h.startRun.mock.calls[0]?.[0] as AgentDeferredQueueMessageInput & { startedAt: number; userMessageUuid: string; runGeneration: number }
    expect(runInput.queueMessageId).toBe('msg-1')
    expect(runInput.userMessageUuid).toBe('msg-1')
    expect(runInput.userMessage).toBe('hello')
    expect(runInput.runGeneration).toBe(1)
    const autoNext = h.startRun.mock.calls[1]?.[0] as AgentDeferredQueueMessageInput & { runGeneration: number }
    expect(autoNext.queueMessageId).toBe('msg-2')

    // run 结束后 dispatching 标记清除
    expect(await Promise.resolve()).toBeUndefined()
    await h.startRun.mock.results[0]?.value
    expect(h.coordinator.isDispatching('session-1')).toBe(false)
  })

  test('Given an active session When injection succeeds Then returns injected without starting a run', async () => {
    const h = createHarness({ active: true })
    h.enqueue('session-1', 'msg-1')

    const result = await h.coordinator.promote('session-1', 'msg-1', true)
    expect(result).toBe('injected')
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0]?.[0]).toEqual(createInput('session-1', 'msg-1'))
    expect(h.inject.mock.calls[0]?.[1]).toBe(true)
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.sendStarted).not.toHaveBeenCalled()
  })

  test('Given an active session When injection turns stale Then 保留到队首等待收尾而不是另开run', async () => {
    const h = createHarness({ active: true })
    h.enqueue('session-1', 'msg-1')
    h.inject.mockResolvedValue(false)

    const result = await h.coordinator.promote('session-1', 'msg-1', false)
    expect(result).toBe('queued')
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.sendStarted).not.toHaveBeenCalled()
    expect(h.coordinator.snapshot('session-1').map(item => item.input.queueMessageId)).toEqual(['msg-1'])
  })

  test('Given an active session When injection fails hard Then message is restored to its original position and error propagates', async () => {
    const h = createHarness({ active: true })
    h.enqueue('session-1', 'msg-1', 'first')
    h.enqueue('session-1', 'msg-2', 'second')
    h.enqueue('session-1', 'msg-3', 'third')
    h.inject.mockImplementation(() => Promise.reject(new Error('connection lost')))

    await expect(h.coordinator.promote('session-1', 'msg-2', false)).rejects.toThrow('connection lost')
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.sendStarted).not.toHaveBeenCalled()

    // msg-2 已恢复到原位置（msg-1 之前不存在：顺序应为 msg-1, msg-2, msg-3）
    const remaining = h.coordinator as unknown as { queues: Map<string, unknown[]> }
    const queue = remaining.queues.get('session-1') as { input: AgentDeferredQueueMessageInput }[]
    expect(queue.map((entry) => entry.input.queueMessageId)).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  test('Given a destroyed webContents When promoting Then message is restored and nothing is sent', async () => {
    const h = createHarness({ active: true })
    h.enqueue('session-1', 'msg-1')
    expect(h.startRun).not.toHaveBeenCalled()
    h.destroyWebContents()
    h.setActive(false)

    const result = await h.coordinator.promote('session-1', 'msg-1', false)
    expect(result).toBe('queued')
    expect(h.sendStarted).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.coordinator.hasPending('session-1')).toBe(true)
  })

  test('Given an idle session with queued messages When a run completes Then the next message is auto-dispatched', async () => {
    const h = createHarness()
    h.enqueue('session-1', 'msg-1')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)

    // 正在派发时不重复启动
    h.enqueue('session-1', 'msg-2')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.coordinator.isDispatching('session-1')).toBe(true)

    await h.startRun.mock.results[0]?.value
    h.coordinator.onRunComplete('session-1', 'msg-1', false, false)
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(2)
    const secondInput = h.startRun.mock.calls[1]?.[0] as AgentDeferredQueueMessageInput
    expect(secondInput.queueMessageId).toBe('msg-2')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('Agent 队列完整收尾与事务门控', () => {
  test('Given queued运行已完成回调但Promise未结束 When 连续唤醒 Then 保持reservation直到真正settle', async () => {
    const h = createHarness()
    const cleanup = deferred<void>()
    h.startRun.mockImplementationOnce(() => cleanup.promise)
    h.enqueue('s', 'a')
    await h.flushAsync()
    h.coordinator.onRunComplete('s', 'a', false, false)
    h.enqueue('s', 'b')
    h.coordinator.onTargetAvailable('s')
    h.coordinator.onBackgroundTaskComplete('s')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.coordinator.isDispatching('s')).toBe(true)
    cleanup.resolve()
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(2)
  })

  test('Given 外部starting或drain屏障 When 入队/提升/恢复目标 Then 无旁路且放行后只运行一次', async () => {
    const h = createHarness()
    h.setBlocked(true)
    h.enqueue('s', 'a')
    h.enqueue('s', 'b')
    expect(await h.coordinator.promote('s', 'b', false)).toBe('queued')
    h.coordinator.onRunDrained('s')
    h.coordinator.onTargetAvailable('s')
    expect(h.sendStarted).not.toHaveBeenCalled()
    expect(h.coordinator.snapshot('s').map(entry => entry.input.queueMessageId)).toEqual(['b', 'a'])
    h.setBlocked(false)
    h.coordinator.onRunDrained('s')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(2)
    expect((h.startRun.mock.calls[0]?.[0] as AgentDeferredQueueMessageInput).queueMessageId).toBe('b')
  })

  test('Given stop暂停 When Promise收尾及被动唤醒 Then 不续发而显式提升可恢复', async () => {
    const h = createHarness()
    const cleanup = deferred<void>()
    h.startRun.mockImplementationOnce(() => cleanup.promise)
    h.enqueue('s', 'a')
    h.enqueue('s', 'b')
    h.coordinator.pauseForStop('s')
    cleanup.resolve()
    await h.flushAsync()
    h.coordinator.onTargetAvailable('s')
    h.coordinator.onBackgroundTaskComplete('s')
    h.coordinator.onRunDrained('s')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.coordinator.snapshot('s')).toHaveLength(1)
    expect(await h.coordinator.promote('s', 'b', false)).toBe('dispatched')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(2)
  })

  for (const outcome of ['stale', 'error'] as const) {
    test(`Given promote等待注入 When clear后${outcome}回包 Then 不恢复已清消息`, async () => {
      const h = createHarness({ active: true })
      const injection = deferred<boolean>()
      h.inject.mockImplementation(() => injection.promise)
      h.enqueue('s', 'a')
      const promoting = h.coordinator.promote('s', 'a', false)
      h.coordinator.clear('s')
      if (outcome === 'error') {
        injection.reject(new Error('真实失败'))
        await expect(promoting).rejects.toThrow('真实失败')
      } else { injection.resolve(false); expect(await promoting).toBe('not_found') }
      expect(h.coordinator.snapshot('s')).toEqual([])
      expect(h.startRun).not.toHaveBeenCalled()
    })
  }

  test('Given promote事务未结束 When 完成和target唤醒 Then 不抢其他队首且成功注入不重复', async () => {
    const h = createHarness({ active: true })
    const injection = deferred<boolean>()
    h.inject.mockImplementation(() => injection.promise)
    h.enqueue('s', 'a')
    h.enqueue('s', 'b')
    const promoting = h.coordinator.promote('s', 'b', true)
    expect(await h.coordinator.promote('s', 'b', true)).toBe('queued')
    h.setActive(false)
    h.coordinator.onRunDrained('s')
    h.coordinator.onTargetAvailable('s')
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.coordinator.hasPending('s')).toBe(true)
    injection.resolve(true)
    expect(await promoting).toBe('injected')
    await h.flushAsync()
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect((h.startRun.mock.calls[0]?.[0] as AgentDeferredQueueMessageInput).queueMessageId).toBe('a')
  })

  test('Given promote期间唯一drain已到 When 注入硬失败 Then 恢复后补唤醒未失败的队首', async () => {
    const h = createHarness({ active: true })
    const injection = deferred<boolean>()
    h.inject.mockImplementation(() => injection.promise)
    h.enqueue('s', 'a')
    h.enqueue('s', 'b')
    const promoting = h.coordinator.promote('s', 'b', true)
    h.setActive(false)
    h.coordinator.onRunDrained('s')
    injection.reject(new Error('连接失败'))
    await expect(promoting).rejects.toThrow('连接失败')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(2)
    expect((h.startRun.mock.calls[0]?.[0] as AgentDeferredQueueMessageInput).queueMessageId).toBe('a')
  })

  test('Given 唯一drain早于背景最终完成 When 同代false到达 Then 重新检查准入并仅启动一次', async () => {
    const h = createHarness({ active: true })
    h.coordinator.onRunStarted('s', 8)
    h.enqueue('s', 'a')
    h.coordinator.onRunComplete('s', undefined, true, false, 8)
    h.setActive(false)
    h.coordinator.onRunDrained('s')
    expect(h.startRun).not.toHaveBeenCalled()
    h.coordinator.onRunComplete('s', undefined, false, false, 8)
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)
  })

  test('Given stop后显式恢复 When 旧stopped终态迟到 Then 不覆盖恢复意图但仍等drain', async () => {
    const h = createHarness({ active: true })
    h.coordinator.onRunStarted('s', 7)
    h.enqueue('s', 'b')
    h.coordinator.pauseForStop('s')
    h.setActive(false)
    h.setBlocked(true)
    expect(await h.coordinator.promote('s', 'b', false)).toBe('queued')
    h.coordinator.onRunComplete('s', undefined, false, true, 7)
    h.setBlocked(false)
    h.coordinator.onRunDrained('s')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)
  })

  test('Given 接受后停止又显式恢复 When 同代展示run_started迟到 Then 不重置接受时的控制版本', async () => {
    const h = createHarness({ active: true })
    h.coordinator.onRunAccepted('s', 7)
    h.enqueue('s', 'a')
    h.coordinator.pauseForStop('s')
    h.coordinator.resumeForExplicitInput('s')
    h.coordinator.onRunStarted('s', 7)
    h.coordinator.onRunComplete('s', undefined, false, true, 7)
    h.setActive(false)
    h.coordinator.onRunDrained('s')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)
  })

  test('Given 同代背景任务未完 When 通知或旧代完成 Then 不解锁，明确完成且drain后才派发', async () => {
    const h = createHarness({ active: true })
    h.coordinator.onRunStarted('s', 8)
    h.enqueue('s', 'a')
    h.coordinator.onRunComplete('s', undefined, true, false, 8)
    h.setActive(false)
    h.coordinator.onRunDrained('s')
    h.coordinator.onBackgroundTaskComplete('s')
    h.coordinator.onRunComplete('s', undefined, false, false, 7)
    h.coordinator.onTargetAvailable('s')
    expect(h.startRun).not.toHaveBeenCalled()
    h.setBlocked(true)
    h.coordinator.onRunComplete('s', undefined, false, false, 8)
    h.coordinator.onTargetAvailable('s')
    expect(h.startRun).not.toHaveBeenCalled()
    h.setBlocked(false)
    h.coordinator.onRunDrained('s')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)
  })

  test('Given started发送失败 When 目标恢复 Then 原文保留且不重复启动', async () => {
    const h = createHarness()
    h.sendStarted.mockImplementationOnce(() => { throw new Error('窗口已销毁') })
    h.enqueue('s', 'a', '原文和引用不变')
    expect(h.coordinator.snapshot('s')[0]?.input.userMessage).toBe('原文和引用不变')
    expect(h.startRun).not.toHaveBeenCalled()
    h.coordinator.onTargetAvailable('s')
    await h.flushAsync()
    expect(h.startRun).toHaveBeenCalledTimes(1)
  })

  test('Given 应用退出 When 运行失败释放reservation Then 不自动续发', async () => {
    const h = createHarness()
    const cleanup = deferred<void>()
    h.startRun.mockImplementationOnce(() => cleanup.promise)
    h.enqueue('s', 'a')
    h.enqueue('s', 'b')
    h.coordinator.shutdown()
    cleanup.reject(new Error('退出'))
    await h.flushAsync()
    h.coordinator.onTargetAvailable('s')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.coordinator.snapshot('s')).toHaveLength(1)
  })
})
