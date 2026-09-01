import { describe, expect, test, mock } from 'bun:test'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus } from '@proma/shared'
import type { WebContents } from 'electron'

interface Harness {
  coordinator: AgentQueueCoordinator
  isActive: (sessionId: string) => boolean
  setActive: (active: boolean) => void
  startRun: ReturnType<typeof mock>
  sendStarted: ReturnType<typeof mock>
  inject: ReturnType<typeof mock>
  enqueue: (sessionId: string, queueMessageId: string, text?: string) => void
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
  const startRun = mock(() => Promise.resolve())
  const sendStarted = mock(() => {})
  const inject = mock(() => Promise.resolve(true))

  const coordinator = new AgentQueueCoordinator({
    isActive: () => active,
    getWebContents: () => (destroyed ? null : webContents),
    startRun,
    sendStarted,
    inject,
  })

  return {
    coordinator,
    isActive: () => active,
    setActive: (next) => { active = next },
    startRun,
    sendStarted,
    inject,
    enqueue: (sessionId, queueMessageId, text) => {
      coordinator.enqueue(createInput(sessionId, queueMessageId, text))
    },
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

    // 只派发被提升的消息，其余留在队列
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.sendStarted).toHaveBeenCalledTimes(1)
    const status = h.sendStarted.mock.calls[0]?.[1] as AgentQueuedMessageStatus
    expect(status.messageId).toBe('msg-1')
    expect(status.sessionId).toBe('session-1')
    expect(typeof status.startedAt).toBe('number')
    const runInput = h.startRun.mock.calls[0]?.[0] as AgentDeferredQueueMessageInput & { startedAt: number; userMessageUuid: string }
    expect(runInput.queueMessageId).toBe('msg-1')
    expect(runInput.userMessageUuid).toBe('msg-1')
    expect(runInput.userMessage).toBe('hello')

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

  test('Given an active session When injection turns stale Then falls back to dispatching the run', async () => {
    const h = createHarness({ active: true })
    h.enqueue('session-1', 'msg-1')
    h.inject.mockResolvedValue(false)

    const result = await h.coordinator.promote('session-1', 'msg-1', false)
    expect(result).toBe('dispatched')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.sendStarted).toHaveBeenCalledTimes(1)
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
    expect(result).toBe('dispatched')
    expect(h.sendStarted).not.toHaveBeenCalled()
    expect(h.startRun).not.toHaveBeenCalled()
    expect(h.coordinator.hasPending('session-1')).toBe(true)
  })

  test('Given an idle session with queued messages When a run completes Then the next message is auto-dispatched', async () => {
    const h = createHarness()
    h.enqueue('session-1', 'msg-1')
    expect(h.startRun).toHaveBeenCalledTimes(1)

    // 正在派发时不重复启动
    h.enqueue('session-1', 'msg-2')
    expect(h.startRun).toHaveBeenCalledTimes(1)
    expect(h.coordinator.isDispatching('session-1')).toBe(true)

    await h.startRun.mock.results[0]?.value
    h.coordinator.onRunComplete('session-1', 'msg-1', false, false)
    expect(h.startRun).toHaveBeenCalledTimes(2)
    const secondInput = h.startRun.mock.calls[1]?.[0] as AgentDeferredQueueMessageInput
    expect(secondInput.queueMessageId).toBe('msg-2')
  })
})
