import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { createSidebarSessionLoader, shouldShowSessionPin } from './sidebar-session-loading'
const session = (id: string): AgentSessionMeta => ({ id, title: id, createdAt: 1, updatedAt: 1 })

describe('侧栏归档与收藏容错', () => {
  test('Given 计数失败 When 打开归档 Then 列表仍加载且计数为未知', async () => {
    let values: AgentSessionMeta[] = [], count: number | null = 0
    const load = createSidebarSessionLoader({
      listActiveAgentSessions: async () => [session('a')], listArchivedAgentSessions: async () => [session('b')],
      countArchivedAgentSessions: async () => { throw new Error('offline') },
    }, (next) => { values = next }, (next) => { count = next })
    await load(true)
    expect(values.map((item) => item.id)).toEqual(['a', 'b'])
    expect(count).toBeNull()
  })
  test('Given 归档请求晚到 When 已返回活跃列表 Then 旧响应不覆盖当前视图', async () => {
    let resolveArchive: ((value: AgentSessionMeta[]) => void) | undefined
    const pending = new Promise<AgentSessionMeta[]>((resolve) => { resolveArchive = resolve })
    let values: AgentSessionMeta[] = []
    const load = createSidebarSessionLoader({ listActiveAgentSessions: async () => [session('active')], listArchivedAgentSessions: () => pending, countArchivedAgentSessions: async () => 1 }, (next) => { values = next }, () => {})
    const old = load(true)
    await load(false)
    resolveArchive!([session('archived')])
    await old
    expect(values.map((item) => item.id)).toEqual(['active'])
  })
  test('Given 收藏和置顶四种组合 When 展示 Then 收藏不显示多余Pin', () => {
    expect(shouldShowSessionPin(true, true)).toBe(false)
    expect(shouldShowSessionPin(true, false)).toBe(true)
    expect(shouldShowSessionPin(false, true)).toBe(false)
    expect(shouldShowSessionPin(false, false)).toBe(false)
  })
})
