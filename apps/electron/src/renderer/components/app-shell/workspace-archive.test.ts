import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@proma/shared'
import { buildArchiveUpdate, canRestoreWorkspace, selectVisibleWorkspaces } from './workspace-archive'

function ws(id: string, overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
  return { id, name: id, slug: id, createdAt: 0, updatedAt: 0, ...overrides }
}

describe('项目归档的展示层过滤', () => {
  test('Given 有归档项目 When 活跃视图 Then 不显示归档项目', () => {
    const list = [ws('a'), ws('b', { archived: true }), ws('c')]
    expect(selectVisibleWorkspaces(list, false).map((w) => w.id)).toEqual(['a', 'c'])
  })

  test('Given 有归档项目 When 包含归档 Then 全部显示', () => {
    const list = [ws('a'), ws('b', { archived: true })]
    expect(selectVisibleWorkspaces(list, true).map((w) => w.id)).toEqual(['a', 'b'])
  })

  test('Given 全部归档 When 活跃视图 Then 返回空数组而不是报错', () => {
    const list = [ws('a', { archived: true }), ws('b', { archived: true })]
    expect(selectVisibleWorkspaces(list, false)).toEqual([])
  })

  test('Given 空列表 When 任意视图 Then 返回空数组', () => {
    expect(selectVisibleWorkspaces([], false)).toEqual([])
    expect(selectVisibleWorkspaces([], true)).toEqual([])
  })

  test('Given 输入数组 When 过滤 Then 不修改原数组', () => {
    const list = [ws('a'), ws('b', { archived: true })]
    selectVisibleWorkspaces(list, false)
    expect(list).toHaveLength(2)
  })

  test('Given 归档 When 构造增量 Then 只带 archived 不碰名称', () => {
    expect(buildArchiveUpdate(true)).toEqual({ archived: true })
  })

  test('Given 恢复 When 构造增量 Then archived 为 undefined 以清掉字段', () => {
    const update = buildArchiveUpdate(false)
    expect('archived' in update).toBe(true)
    expect(update.archived).toBeUndefined()
  })

  test('Given 归档项目 When 判断能否恢复 Then true', () => {
    expect(canRestoreWorkspace(ws('a', { archived: true }))).toBe(true)
  })

  test('Given 未归档项目 When 判断能否恢复 Then false', () => {
    expect(canRestoreWorkspace(ws('a'))).toBe(false)
  })

  test('Given archived 显式为 false When 判断能否恢复 Then false', () => {
    expect(canRestoreWorkspace(ws('a', { archived: false }))).toBe(false)
  })
})
