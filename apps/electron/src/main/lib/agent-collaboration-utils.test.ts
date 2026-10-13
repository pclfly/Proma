import { describe, expect, test } from 'bun:test'
import { normalizePersistedDelegationStatus, resolveDelegationWaitStatus } from './agent-collaboration-utils'

describe('wait_for_delegations 收敛判定', () => {
  test('Given 完成数达到目标 When 判定 Then 返回 completed', () => {
    expect(resolveDelegationWaitStatus({ finishedCount: 3, targetCompleted: 3 })).toBe('completed')
  })

  test('Given 仍有子会话运行导致完成数不足 When 判定 Then 返回 timeout 而非误报完成', () => {
    expect(resolveDelegationWaitStatus({ finishedCount: 2, targetCompleted: 3 })).toBe('timeout')
  })

  test('Given mode=any 已有足够完成数 When 判定 Then 返回 completed', () => {
    expect(resolveDelegationWaitStatus({ finishedCount: 2, targetCompleted: 1 })).toBe('completed')
  })
})

describe('持久化委派状态归一化', () => {
  test('Given 磁盘残留 running When 委派不在内存 Then 视为 interrupted', () => {
    expect(normalizePersistedDelegationStatus('running')).toBe('interrupted')
  })

  test('Given 缺少状态 When 归一化 Then 视为 interrupted', () => {
    expect(normalizePersistedDelegationStatus(undefined)).toBe('interrupted')
  })

  test('Given 已是终态 When 归一化 Then 保持原状态', () => {
    expect(normalizePersistedDelegationStatus('completed')).toBe('completed')
    expect(normalizePersistedDelegationStatus('failed')).toBe('failed')
  })
})
