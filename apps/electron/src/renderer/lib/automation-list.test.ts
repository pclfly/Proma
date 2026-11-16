/**
 * 定时任务列表项目分组 BDD 测试
 */

import { describe, expect, test } from 'bun:test'
import type { Automation } from '@proma/shared'
import {
  groupAutomationsByWorkspace,
  hasRunningAutomationRun,
  UNASSIGNED_WORKSPACE_LABEL,
  UNKNOWN_WORKSPACE_LABEL,
} from './automation-list'

function createAutomation(overrides: Partial<Automation>): Automation {
  return {
    id: 'auto-1',
    name: '任务',
    prompt: '提示词',
    active: true,
    scheduleType: 'interval',
    intervalMinutes: 10,
    channelId: 'channel-1',
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 1_000,
    runHistory: [],
    ...overrides,
  }
}

const byName = (a: Automation, b: Automation): number => a.name.localeCompare(b.name, 'zh-CN')

describe('groupAutomationsByWorkspace', () => {
  test('Given 跨项目的任务 When 分组 Then 按项目名排序且未分配项目固定最后', () => {
    const tasks = [
      createAutomation({ id: 'a1', name: 'Beta 任务', workspaceId: 'ws-2' }),
      createAutomation({ id: 'a2', name: 'Alpha 任务', workspaceId: 'ws-1' }),
      createAutomation({ id: 'a3', name: '游离任务', workspaceId: undefined }),
    ]

    const groups = groupAutomationsByWorkspace(
      tasks,
      new Map([['ws-1', 'Alpha 项目'], ['ws-2', 'Beta 项目']]),
      byName,
    )

    expect(groups.map((group) => group.name)).toEqual(['Alpha 项目', 'Beta 项目', UNASSIGNED_WORKSPACE_LABEL])
    expect(groups[0]?.automations.map((task) => task.id)).toEqual(['a2'])
    expect(groups[1]?.automations.map((task) => task.id)).toEqual(['a1'])
    expect(groups[2]?.workspaceId).toBe('')
  })

  test('Given 同一项目内多个任务 When 分组 Then 组内按传入比较器排序', () => {
    const tasks = [
      createAutomation({ id: 'b', name: 'B 任务', workspaceId: 'ws-1' }),
      createAutomation({ id: 'a', name: 'A 任务', workspaceId: 'ws-1' }),
    ]

    const groups = groupAutomationsByWorkspace(tasks, new Map([['ws-1', '项目一']]), byName)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.automations.map((task) => task.name)).toEqual(['A 任务', 'B 任务'])
  })

  test('Given 工作区已被删除 When 分组 Then 用未知项目兜底而不是丢任务', () => {
    const tasks = [createAutomation({ id: 'a1', workspaceId: 'ws-missing' })]

    const groups = groupAutomationsByWorkspace(tasks, new Map(), byName)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe(UNKNOWN_WORKSPACE_LABEL)
    expect(groups[0]?.automations).toHaveLength(1)
  })

  test('Given 组内存在 running 运行 When 分组 Then 标记 hasRunningRun', () => {
    const running = createAutomation({
      id: 'running',
      workspaceId: 'ws-1',
      runHistory: [{ runId: 'run-1', runAt: 1, sessionId: 's-1', status: 'running' }],
    })
    const idle = createAutomation({
      id: 'idle',
      workspaceId: 'ws-2',
      runHistory: [{ runId: 'run-2', runAt: 1, sessionId: 's-2', status: 'success' }],
    })

    const groups = groupAutomationsByWorkspace(
      [running, idle],
      new Map([['ws-1', '项目一'], ['ws-2', '项目二']]),
      byName,
    )

    expect(groups.find((group) => group.workspaceId === 'ws-1')?.hasRunningRun).toBe(true)
    expect(groups.find((group) => group.workspaceId === 'ws-2')?.hasRunningRun).toBe(false)
    expect(hasRunningAutomationRun(running)).toBe(true)
    expect(hasRunningAutomationRun(idle)).toBe(false)
  })
})
