import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { selectStarredSessions, starredViewNeedsArchived } from './starred-sessions'

function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id, title: id, createdAt: 0, updatedAt: 0, ...overrides } as AgentSessionMeta
}

describe('收藏视图筛选', () => {
  test('Given 混合会话 When 筛选 Then 只保留星标', () => {
    const list = [
      session('a', { starred: true }),
      session('b'),
      session('c', { starred: true }),
    ]
    expect(selectStarredSessions(list).map((s) => s.id)).toEqual(['a', 'c'])
  })

  test('Given 已归档的星标会话 When 筛选 Then 仍然展示（收藏与归档正交）', () => {
    const list = [session('a', { starred: true, archived: true })]
    expect(selectStarredSessions(list).map((s) => s.id)).toEqual(['a'])
  })

  test('Given 星标草稿 When 筛选 Then 不展示', () => {
    const list = [session('a', { starred: true, isDraft: true })]
    expect(selectStarredSessions(list)).toHaveLength(0)
  })

  test('Given 正在删除的星标会话 When 筛选 Then 立即排除避免闪回', () => {
    const list = [session('a', { starred: true }), session('b', { starred: true })]
    expect(selectStarredSessions(list, { pendingDeleteId: 'a' }).map((s) => s.id)).toEqual(['b'])
  })

  test('Given 批量删除中的草稿集合 When 筛选 Then 一并排除', () => {
    const list = [session('a', { starred: true }), session('b', { starred: true })]
    expect(selectStarredSessions(list, { draftSessionIds: new Set(['b']) }).map((s) => s.id)).toEqual(['a'])
  })

  test('Given 置顶与未置顶 When 排序 Then 置顶优先', () => {
    const list = [
      session('new-no-pin', { starred: true, updatedAt: 100 }),
      session('old-pinned', { starred: true, updatedAt: 1, pinned: true }),
    ]
    expect(selectStarredSessions(list).map((s) => s.id)).toEqual(['old-pinned', 'new-no-pin'])
  })

  test('Given 同为置顶 When 排序 Then 按更新时间倒序', () => {
    const list = [
      session('older', { starred: true, pinned: true, updatedAt: 10 }),
      session('newer', { starred: true, pinned: true, updatedAt: 20 }),
    ]
    expect(selectStarredSessions(list).map((s) => s.id)).toEqual(['newer', 'older'])
  })

  test('Given 空列表 When 筛选 Then 返回空数组', () => {
    expect(selectStarredSessions([])).toEqual([])
  })

  test('Given 输入数组 When 筛选 Then 不修改原数组顺序', () => {
    const list = [
      session('a', { starred: true, updatedAt: 10 }),
      session('b', { starred: true, updatedAt: 20 }),
    ]
    selectStarredSessions(list)
    expect(list.map((s) => s.id)).toEqual(['a', 'b'])
  })

  test('Given 收藏视图需要归档会话可见 When 询问 Then 需要加载归档列表', () => {
    expect(starredViewNeedsArchived(true)).toBe(true)
    expect(starredViewNeedsArchived(false)).toBe(false)
  })
})
