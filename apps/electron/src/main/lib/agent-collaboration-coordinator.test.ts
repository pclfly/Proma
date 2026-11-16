import { describe, expect, test } from 'bun:test'
import type { AgentCollaborationScopeSnapshot } from '@proma/shared'
import {
  COLLABORATION_DEADLINE_MS,
  COLLABORATION_MAX_EXECUTIONS,
  CollaborationCoordinator,
  CollaborationNotifier,
} from './agent-collaboration-coordinator'

function fixture(previous?: AgentCollaborationScopeSnapshot) {
  const persisted: AgentCollaborationScopeSnapshot[] = []
  const coordinator = new CollaborationCoordinator(previous, (snapshot) => {
    persisted.push(structuredClone(snapshot))
  })
  return { coordinator, persisted }
}

describe('协作 scope 协调器', () => {
  test('Given 新 scope When track 同 attempt 两次 Then 只计一轮并持久化', () => {
    const { coordinator, persisted } = fixture()
    coordinator.track('d1', 'a1', { title: 'title', startedAt: 1 })
    coordinator.track('d1', 'a1')
    expect(coordinator.snapshot.dependencies).toHaveLength(1)
    expect(coordinator.snapshot.rounds).toBe(1)
    expect(coordinator.ids()).toEqual(['d1'])
    expect(persisted).toHaveLength(1)
  })

  test('Given 轮次达到上限 When 再启动 Then 拒绝并保留原依赖', () => {
    const { coordinator } = fixture()
    for (let index = 0; index < COLLABORATION_MAX_EXECUTIONS; index += 1) {
      coordinator.track(`d${index}`, `a${index}`)
    }
    expect(() => coordinator.track('overflow', 'overflow')).toThrow(
      `协作任务已达到轮次预算（${COLLABORATION_MAX_EXECUTIONS} 次执行）`,
    )
    expect(coordinator.snapshot.dependencies).toHaveLength(COLLABORATION_MAX_EXECUTIONS)
  })

  test('Given deadline 已过 When assertCanStart Then 拒绝；空依赖旧 scope 自动滚动', () => {
    const { coordinator } = fixture()
    coordinator.snapshot.deadline = Date.now() - 1
    expect(() => coordinator.assertCanStart()).not.toThrow()
    expect(coordinator.snapshot.deadline).toBeGreaterThan(Date.now())
    coordinator.track('d1', 'a1')
    coordinator.snapshot.deadline = Date.now() - 1
    expect(() => coordinator.assertCanStart()).toThrow('协作任务已超过截止时间')
  })

  test('Given 已取消 When 启动 Then 拒绝', () => {
    const { coordinator } = fixture()
    coordinator.cancel()
    expect(coordinator.snapshot.cancelled).toBe(true)
    expect(coordinator.snapshot.closed).toBe(true)
    expect(() => coordinator.assertCanStart()).toThrow('协作任务已取消')
  })

  test('Given 外部与自有凭据 When acknowledge Then 只接受 attempt/blocked/deadline', () => {
    const { coordinator, persisted } = fixture()
    coordinator.track('d1', 'a1')
    coordinator.acknowledge(['a1', 'foreign', 'a1:blocked:b1', `${coordinator.snapshot.scopeId}:deadline`])
    expect(coordinator.snapshot.delivered).toEqual([
      'a1',
      'a1:blocked:b1',
      `${coordinator.snapshot.scopeId}:deadline`,
    ])
    expect(coordinator.hasReceipt('a1')).toBe(true)
    expect(coordinator.hasReceipt('foreign')).toBe(false)
    const writes = persisted.length
    coordinator.acknowledge(['a1'])
    expect(persisted).toHaveLength(writes)
  })

  test('Given 结果列表 When receiptsFor Then running 不产生完成凭据，阻塞问题按 attempt 关联', () => {
    const { coordinator } = fixture()
    coordinator.track('d1', 'a1')
    coordinator.track('d2', 'a2')
    expect(coordinator.receiptsFor([
      { delegationId: 'd1', attemptId: 'a1', status: 'running', pendingBlockedEvents: [{ id: 'b1' }] },
      { delegationId: 'd2', attemptId: 'a2', status: 'completed' },
      { delegationId: 'd3', attemptId: 'a3', status: 'completed' },
    ])).toEqual(['a1:blocked:b1', 'a2'])
  })

  test('Given 未关闭持久化 scope When 重建 Then 继续原 scope 与凭据', () => {
    const { coordinator } = fixture()
    coordinator.track('d1', 'a1')
    const restored = new CollaborationCoordinator(
      structuredClone(coordinator.snapshot),
      () => undefined,
    )
    expect(restored.snapshot.scopeId).toBe(coordinator.snapshot.scopeId)
    expect(restored.snapshot.delivered).toEqual([])
    restored.acknowledge(['a1'])
    expect(restored.hasReceipt('a1')).toBe(true)
  })

  test('Given 已关闭 scope When 构造 Then 生成新 scope', () => {
    const { coordinator } = fixture()
    coordinator.close()
    const restored = new CollaborationCoordinator(
      structuredClone(coordinator.snapshot),
      () => undefined,
    )
    expect(restored.snapshot.scopeId).not.toBe(coordinator.snapshot.scopeId)
    expect(restored.snapshot.closed).toBe(false)
  })

  test('Given 通知器 When notify/超时/取消 Then 正确释放监听', async () => {
    const notifier = new CollaborationNotifier()
    let value = 0
    const waiting = notifier.wait(() => (value > 0 ? value : undefined), 1_000)
    expect(notifier.listenerCount).toBe(1)
    value = 1
    notifier.notify()
    await expect(waiting).resolves.toBe(1)
    expect(notifier.listenerCount).toBe(0)

    await expect(notifier.wait(() => undefined, 1)).resolves.toBeUndefined()
    expect(notifier.listenerCount).toBe(0)

    const controller = new AbortController()
    const aborted = notifier.wait(() => undefined, 10_000, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toThrow('协作等待已取消')
    expect(notifier.listenerCount).toBe(0)
  })

  test('Given 检查抛错 When wait Then 原样拒绝并清理', async () => {
    const notifier = new CollaborationNotifier()
    await expect(notifier.wait(() => {
      throw new Error('check failed')
    }, 1_000)).rejects.toThrow('check failed')
    expect(notifier.listenerCount).toBe(0)
  })

  test('Given deadline 常量 When 读取 Then 为两小时', () => {
    expect(COLLABORATION_DEADLINE_MS).toBe(2 * 60 * 60 * 1_000)
  })
})
