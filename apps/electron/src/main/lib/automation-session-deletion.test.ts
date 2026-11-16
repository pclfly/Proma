import { describe, expect, test } from 'bun:test'
import { selectDeletableAutomationSessions, type AutomationSessionCandidate } from './automation-session-deletion'

function s(id: string, overrides: Partial<AutomationSessionCandidate> = {}): AutomationSessionCandidate {
  return { id, ...overrides }
}

describe('删除自动化任务时的历史会话筛选', () => {
  test('Given 只选本任务的会话 When 筛选 Then 不删其它任务或无来源的会话', () => {
    const sessions = [
      s('a1', { sourceAutomationId: 'auto-1' }),
      s('a2', { sourceAutomationId: 'auto-1' }),
      s('b1', { sourceAutomationId: 'auto-2' }),
      s('manual'),
    ]
    const picked = selectDeletableAutomationSessions(sessions, 'auto-1', new Set())
    expect(picked.map((x) => x.id)).toEqual(['a1', 'a2'])
  })

  test('Given 某会话正在运行 When 筛选 Then 该会话不删', () => {
    const sessions = [s('a1', { sourceAutomationId: 'auto-1' })]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set(['a1']))).toHaveLength(0)
  })

  test('Given 已提升为普通会话 When 筛选 Then 不删它', () => {
    const sessions = [s('a1', { sourceAutomationId: 'auto-1', automationGraduated: true })]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set())).toHaveLength(0)
  })

  test('Given 父会话已提升 When 子会话仍在任务下 Then 整个分量受保护', () => {
    const sessions = [
      s('parent', { sourceAutomationId: 'auto-1', automationGraduated: true }),
      s('child', { sourceAutomationId: 'auto-1', parentSessionId: 'parent' }),
    ]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set())).toHaveLength(0)
  })

  test('Given 子会话仍在运行 When 父会话空闲 Then 父也不删', () => {
    const sessions = [
      s('parent', { sourceAutomationId: 'auto-1' }),
      s('child', { sourceAutomationId: 'auto-1', parentSessionId: 'parent' }),
    ]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set(['child']))).toHaveLength(0)
  })

  test('Given 保护只在相邻分量内 When 另一分量空闲 Then 另一分量照常删除', () => {
    const sessions = [
      s('p1', { sourceAutomationId: 'auto-1' }),
      s('c1', { sourceAutomationId: 'auto-1', parentSessionId: 'p1' }),
      s('p2', { sourceAutomationId: 'auto-1' }),
      s('c2', { sourceAutomationId: 'auto-1', parentSessionId: 'p2' }),
    ]
    const picked = selectDeletableAutomationSessions(sessions, 'auto-1', new Set(['c1']))
    expect(picked.map((x) => x.id)).toEqual(['p2', 'c2'])
  })

  test('Given 父会话不属于本任务 When 它在运行 Then 子会话也受保护（分量跨任务传播）', () => {
    const sessions = [
      s('parent', { sourceAutomationId: 'auto-2' }),
      s('child', { sourceAutomationId: 'auto-1', parentSessionId: 'parent' }),
    ]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set(['parent']))).toHaveLength(0)
  })

  test('Given 父会话 id 不存在 When 筛选 Then 不因悬空引用报错', () => {
    const sessions = [s('a1', { sourceAutomationId: 'auto-1', parentSessionId: 'missing' })]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set()).map((x) => x.id)).toEqual(['a1'])
  })

  test('Given 深链父子 When 末端运行中 Then 全链受保护', () => {
    const sessions = [
      s('a', { sourceAutomationId: 'auto-1' }),
      s('b', { sourceAutomationId: 'auto-1', parentSessionId: 'a' }),
      s('c', { sourceAutomationId: 'auto-1', parentSessionId: 'b' }),
    ]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set(['c']))).toHaveLength(0)
  })

  test('Given 空会话列表 When 筛选 Then 返回空数组', () => {
    expect(selectDeletableAutomationSessions([], 'auto-1', new Set())).toEqual([])
  })

  test('Given 任务无任何会话 When 筛选 Then 返回空数组', () => {
    const sessions = [s('x', { sourceAutomationId: 'auto-9' })]
    expect(selectDeletableAutomationSessions(sessions, 'auto-1', new Set())).toEqual([])
  })
})
