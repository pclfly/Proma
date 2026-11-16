import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import {
  getAgentSessionActivityTime,
  mergeFetchedAgentSessions,
  sortAgentSessionsByUpdatedAtDesc,
  upsertAgentSession,
} from './agent-session-list'

function session(
  id: string,
  activity: number,
  updatedAt = activity,
  extra: Partial<AgentSessionMeta> = {},
): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    lastActivityAt: activity,
    updatedAt,
    ...extra,
  }
}

describe('Agent 会话活动时间排序', () => {
  test('Given 元数据更新的 updatedAt 更晚 When 排序 Then 仍按 lastActivityAt', () => {
    const older = session('older', 1_000, 9_000)
    const newer = session('newer', 2_000, 2_000)

    expect(sortAgentSessionsByUpdatedAtDesc([older, newer]).map((item) => item.id)).toEqual([
      'newer',
      'older',
    ])
  })

  test('Given 历史会话缺少 lastActivityAt When 读取活动时间 Then 回退到 updatedAt', () => {
    const legacy = { id: 'legacy', title: 'legacy', createdAt: 1, updatedAt: 3_000 }

    expect(getAgentSessionActivityTime(legacy)).toBe(3_000)
  })

  test('Given 标题更新事件不带 lastActivityAt When upsert Then 保留原活动时间且不跳顶', () => {
    const previous = [session('older', 1_000, 1_000), session('newer', 2_000, 2_000)]
    const titlePayload = {
      ...previous[0]!,
      title: '新的标题',
      updatedAt: 9_000,
      lastActivityAt: undefined,
    }

    const next = upsertAgentSession(previous, titlePayload)

    expect(next.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(next.find((item) => item.id === 'older')?.lastActivityAt).toBe(1_000)
  })

  test('Given 活动事件带来更新的 lastActivityAt When upsert Then 前进并置顶', () => {
    const previous = [session('older', 1_000, 1_000), session('newer', 2_000, 2_000)]

    const next = upsertAgentSession(previous, session('older', 3_000, 3_000))

    expect(next.map((item) => item.id)).toEqual(['older', 'newer'])
  })

  test('Given 陈旧全量快照 When 合并 Then 保留本地标题与最大活动时间', () => {
    const local = [session('a', 5_000, 5_000, { title: '本地标题' })]
    const fetched = [session('a', 4_000, 4_000, { title: '旧标题' })]

    const merged = mergeFetchedAgentSessions(local, fetched)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.title).toBe('本地标题')
    expect(getAgentSessionActivityTime(merged[0]!)).toBe(5_000)
  })
})
