import { describe, expect, test } from 'bun:test'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { aggregateTaskItems, getTaskProgressCounts } from './task-progress'

function act(toolName: string, input: Record<string, unknown>, result?: string, toolUseId = 'tu'): ToolActivity {
  return { toolName, input, result, toolUseId } as unknown as ToolActivity
}

function createTask(realId: string, subject: string, toolUseId: string, withResult = true): ToolActivity {
  return act('TaskCreate', { subject }, withResult ? JSON.stringify({ task: { id: realId, subject } }) : undefined, toolUseId)
}

describe('任务进度：TaskCreate 缺 result 时的 id 归一', () => {
  test('Given TaskCreate 有 result When TaskUpdate 用真实 id Then 命中同一条目', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('2', 'B', 'tu-2'),
      act('TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 'tu-3'),
    ], false)
    expect(items).toHaveLength(2)
    expect(getTaskProgressCounts(items)).toMatchObject({ completed: 1, total: 2 })
  })

  test('Given TaskCreate 缺 result When TaskUpdate 用真实 id Then 不新建孤立任务', () => {
    // 这是 "0/N 一直不变" 的根因：旧实现会多出一条 "任务 #1" 把分母撑大。
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1', false),
      createTask('2', 'B', 'tu-2', false),
      act('TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 'tu-3'),
    ], false)
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.subject)).toEqual(['A', 'B'])
    expect(items.find((item) => item.status === 'completed')?.subject).toBe('A')
    expect(getTaskProgressCounts(items)).toMatchObject({ completed: 1, total: 2 })
  })

  test('Given TaskCreate 缺 result When TaskUpdate 用 toolUseId Then 同样命中', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1', false),
      act('TaskUpdate', { taskId: 'tu-1', status: 'completed' }, undefined, 'tu-3'),
    ], false)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ subject: 'A', status: 'completed' })
  })

  test('Given 两个 TaskCreate 后连续更新 When 全部完成 Then 分子等于分母', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1', false),
      createTask('2', 'B', 'tu-2', false),
      act('TaskUpdate', { taskId: '1', status: 'completed' }),
      act('TaskUpdate', { taskId: '2', status: 'completed' }),
    ], false)
    const counts = getTaskProgressCounts(items)
    expect(counts.completed).toBe(2)
    expect(counts.total).toBe(2)
    expect(counts.hasActive).toBe(false)
  })

  test('Given 同一任务被多次 TaskCreate When 聚合 Then 不重复计数', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('1', 'A', 'tu-1'),
    ], false)
    expect(items).toHaveLength(1)
  })

  test('Given 无 subject 的孤立更新 When 聚合 Then 仍能显示可读标题', () => {
    const items = aggregateTaskItems([
      act('TaskUpdate', { taskId: '9', status: 'in_progress' }),
    ], false)
    expect(items[0]?.subject).toBe('任务 #9')
  })
})

describe('任务进度：分母口径', () => {
  test('Given 含取消任务 When 计数 Then 取消项不计入分母', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('2', 'B', 'tu-2'),
      act('TaskUpdate', { taskId: '1', status: 'completed' }),
      act('TaskUpdate', { taskId: '2', status: 'cancelled' }),
    ], false)
    // 旧口径会得到 1/2 并长期停在这里；新口径剔除取消项后是 1/1。
    expect(getTaskProgressCounts(items)).toMatchObject({ completed: 1, total: 1, hasActive: false })
  })

  test('Given 含报错任务 When 计数 Then 报错项仍计入分母', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('2', 'B', 'tu-2'),
      act('TaskUpdate', { taskId: '1', status: 'completed' }),
      act('TaskUpdate', { taskId: '2', status: 'error' }),
    ], false)
    // 失败必须被看见，不能靠剔除掩盖。
    expect(getTaskProgressCounts(items)).toMatchObject({ completed: 1, total: 2, hasActive: false })
  })

  test('Given 全部取消 When 计数 Then 分母为 0 且无活跃任务', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      act('TaskUpdate', { taskId: '1', status: 'cancelled' }),
    ], false)
    expect(getTaskProgressCounts(items)).toMatchObject({ completed: 0, total: 0, hasActive: false })
  })

  test('Given 全部完成 When 计数 Then 分子等于分母且无活跃', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('2', 'B', 'tu-2'),
      act('TaskUpdate', { taskId: '1', status: 'completed' }),
      act('TaskUpdate', { taskId: '2', status: 'completed' }),
    ], false)
    const counts = getTaskProgressCounts(items)
    expect(counts.completed).toBe(counts.total)
    expect(counts.hasActive).toBe(false)
  })

  test('Given 存在 pending 任务 When 计数 Then hasActive 为 true', () => {
    const items = aggregateTaskItems([
      createTask('1', 'A', 'tu-1'),
      createTask('2', 'B', 'tu-2'),
      act('TaskUpdate', { taskId: '1', status: 'completed' }),
    ], false)
    expect(getTaskProgressCounts(items).hasActive).toBe(true)
  })
})
