import { describe, expect, test } from 'bun:test'
import type { AttributedKnowledgeChange } from '@proma/shared'
import {
  applySessionKnowledgeChange,
  clearSessionKnowledgeChanges,
  describeKnowledgeTarget,
  listSessionKnowledgeChanges,
  MAX_SESSION_KNOWLEDGE_CHANGES,
} from './session-knowledge-changes'

function change(sessionId: string, changeId: string, runGeneration = 1, kind: 'memory' | 'workspace_agents' = 'memory'): AttributedKnowledgeChange {
  return {
    changeId,
    workspaceId: 'ws',
    workspaceSlug: 'demo',
    file: kind === 'memory' ? { kind, relativePath: 'notes/a.md' } : { kind },
    source: { sessionId, runGeneration, queryId: `q-${changeId}`, toolCallId: `t-${changeId}`, toolName: 'write' },
    changedAt: 1,
    kind: 'modified',
    diff: { context: [], removed: ['旧'], added: ['新'], truncated: false },
  }
}

describe('会话级记忆来源列表', () => {
  test('Given 外层会话与来源一致 When 接收 Then 只写该会话', () => {
    const next = applySessionKnowledgeChange(new Map(), { sessionId: 'A', change: change('A', 'c1') })
    expect(listSessionKnowledgeChanges(next, 'A').map(item => item.changeId)).toEqual(['c1'])
    expect(listSessionKnowledgeChanges(next, 'B')).toEqual([])
  })

  test('Given 外层会话与来源不一致 When 接收 Then 拒绝而不是归给当前会话', () => {
    const next = applySessionKnowledgeChange(new Map(), { sessionId: 'A', change: change('B', 'c1') })
    expect(next.size).toBe(0)
  })

  test('Given 重复changeId When 重复投递 Then 只保留一条', () => {
    const first = applySessionKnowledgeChange(new Map(), { sessionId: 'A', change: change('A', 'c1') })
    const second = applySessionKnowledgeChange(first, { sessionId: 'A', change: change('A', 'c1') })
    expect(second).toBe(first)
    expect(listSessionKnowledgeChanges(second, 'A')).toHaveLength(1)
  })

  test('Given 旧代次迟到 When 当前代际已知 Then 丢弃旧来源事件', () => {
    const next = applySessionKnowledgeChange(new Map(), {
      sessionId: 'A', change: change('A', 'old', 2), activeRunGeneration: 3,
    })
    expect(listSessionKnowledgeChanges(next, 'A')).toEqual([])
    const newer = applySessionKnowledgeChange(next, {
      sessionId: 'A', change: change('A', 'new', 3), activeRunGeneration: 3,
    })
    expect(listSessionKnowledgeChanges(newer, 'A').map(item => item.changeId)).toEqual(['new'])
  })

  test('Given 连续多次写入 When 接收 Then 最新的在前且条目数量有界', () => {
    let state: Map<string, AttributedKnowledgeChange[]> = new Map()
    for (let index = 0; index < MAX_SESSION_KNOWLEDGE_CHANGES + 5; index += 1) {
      state = applySessionKnowledgeChange(state, { sessionId: 'A', change: change('A', `c${index}`) })
    }
    const list = listSessionKnowledgeChanges(state, 'A')
    expect(list).toHaveLength(MAX_SESSION_KNOWLEDGE_CHANGES)
    expect(list[0]?.changeId).toBe(`c${MAX_SESSION_KNOWLEDGE_CHANGES + 4}`)
  })

  test('Given 未选择会话 When 读取 Then 不返回任何来源 diff', () => {
    const state = applySessionKnowledgeChange(new Map(), { sessionId: 'A', change: change('A', 'c1') })
    expect(listSessionKnowledgeChanges(state, null)).toEqual([])
    expect(listSessionKnowledgeChanges(state, undefined)).toEqual([])
  })

  test('Given 会话被删除 When 清理 Then 只移除该会话且其它会话保留', () => {
    let state = applySessionKnowledgeChange(new Map(), { sessionId: 'A', change: change('A', 'a1') })
    state = applySessionKnowledgeChange(state, { sessionId: 'B', change: change('B', 'b1') })
    const cleaned = clearSessionKnowledgeChanges(state, 'A')
    expect(listSessionKnowledgeChanges(cleaned, 'A')).toEqual([])
    expect(listSessionKnowledgeChanges(cleaned, 'B')).toHaveLength(1)
    expect(clearSessionKnowledgeChanges(cleaned, 'A')).toBe(cleaned)
  })

  test('Given 三种目标 When 生成标题 Then 区分记忆文件与两份 AGENTS', () => {
    expect(describeKnowledgeTarget(change('A', 'c1'))).toContain('协作记忆')
    expect(describeKnowledgeTarget(change('A', 'c2', 1, 'workspace_agents'))).toContain('Proma 工作区规则')
  })
})


describe('来源清理水位与全局容量', () => {
  test('Given 已清理代际 When 迟到事件到达 Then 不复活旧记录但新代际可接收', () => {
    const empty = new Map<string, AttributedKnowledgeChange[]>()
    expect(applySessionKnowledgeChange(empty, { sessionId: 'A', change: change('A', 'old', 5), blockedRunGeneration: 5 })).toBe(empty)
    expect(applySessionKnowledgeChange(empty, { sessionId: 'A', change: change('A', 'new', 6), blockedRunGeneration: 5 }).get('A')).toHaveLength(1)
  })
  test('Given 大量会话来源 When 超过全局容量 Then 淘汰最久未更新会话不无限保留正文', () => {
    let state = new Map<string, AttributedKnowledgeChange[]>()
    for (let index = 0; index < 105; index += 1) {
      const id = `S${index}`
      state = applySessionKnowledgeChange(state, { sessionId: id, change: change(id, `c${index}`) })
    }
    expect(state.size).toBe(100)
    expect(state.has('S0')).toBe(false)
    expect(state.has('S104')).toBe(true)
  })
})
