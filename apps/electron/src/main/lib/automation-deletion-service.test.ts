import { describe, expect, test } from 'bun:test'
import type { AutomationSessionCandidate } from './automation-session-deletion'
import { deleteAutomationWithHistoricalSessions } from './automation-deletion-service'

interface HarnessOptions {
  exists?: boolean
  sessions?: AutomationSessionCandidate[]
  busy?: string[]
  failOn?: string[]
  deleteThrows?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const exists = options.exists ?? true
  const sessions = options.sessions ?? []
  const busy = new Set(options.busy ?? [])
  const failOn = new Set(options.failOn ?? [])
  const deletedSessions: string[] = []
  const errors: string[] = []
  let taskDeleted = 0

  return {
    deletedSessions,
    errors,
    taskDeleted: () => taskDeleted,
    deps: {
      getAutomation: () => (exists ? { id: 'auto-1' } : undefined),
      deleteAutomation: () => { taskDeleted++; return exists },
      listAgentSessions: () => sessions,
      isSessionBusy: (sessionId: string) => busy.has(sessionId),
      deleteSession: (sessionId: string) => {
        if (failOn.has(sessionId)) throw new Error(`删除失败: ${sessionId}`)
        deletedSessions.push(sessionId)
      },
      onSessionDeleteError: (_automationId: string, sessionId: string, error: unknown) => {
        errors.push(`${sessionId}:${error instanceof Error ? error.message : String(error)}`)
      },
    },
  }
}

describe('删除自动化任务并清理历史会话', () => {
  test('Given 任务不存在 When 删除 Then 不删任何会话', async () => {
    const h = makeHarness({ exists: false, sessions: [{ id: 'a1', sourceAutomationId: 'auto-1' }] })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result).toEqual({ deleted: false, deletedHistoricalSessionCount: 0, failedHistoricalSessionCount: 0 })
    expect(h.deletedSessions).toHaveLength(0)
    expect(h.taskDeleted()).toBe(0)
  })

  test('Given 任务存在且有两条历史会话 When 删除 Then 任务与会话都删除', async () => {
    const h = makeHarness({
      sessions: [
        { id: 'a1', sourceAutomationId: 'auto-1' },
        { id: 'a2', sourceAutomationId: 'auto-1' },
        { id: 'other', sourceAutomationId: 'auto-2' },
      ],
    })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result).toEqual({ deleted: true, deletedHistoricalSessionCount: 2, failedHistoricalSessionCount: 0 })
    expect(h.deletedSessions).toEqual(['a1', 'a2'])
  })

  test('Given 会话正在运行 When 删除 Then 跳过该会话', async () => {
    const h = makeHarness({
      sessions: [{ id: 'a1', sourceAutomationId: 'auto-1' }],
      busy: ['a1'],
    })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result.deletedHistoricalSessionCount).toBe(0)
    expect(h.deletedSessions).toHaveLength(0)
  })

  test('Given 单条删除失败 When 删除 Then 计数并继续处理其余会话', async () => {
    const h = makeHarness({
      sessions: [
        { id: 'a1', sourceAutomationId: 'auto-1' },
        { id: 'a2', sourceAutomationId: 'auto-1' },
        { id: 'a3', sourceAutomationId: 'auto-1' },
      ],
      failOn: ['a2'],
    })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result).toEqual({ deleted: true, deletedHistoricalSessionCount: 2, failedHistoricalSessionCount: 1 })
    expect(h.deletedSessions).toEqual(['a1', 'a3'])
    expect(h.errors[0]).toContain('a2')
  })

  test('Given 已提升为普通会话 When 删除 Then 不删它', async () => {
    const h = makeHarness({
      sessions: [{ id: 'a1', sourceAutomationId: 'auto-1', automationGraduated: true }],
    })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result.deletedHistoricalSessionCount).toBe(0)
  })

  test('Given 任务删除返回 false When 处理 Then 结果如实反映', async () => {
    const h = makeHarness({ sessions: [] })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', {
      ...h.deps,
      deleteAutomation: () => false,
    })
    expect(result.deleted).toBe(false)
  })

  test('Given 无任何来源会话 When 删除 Then 只删任务', async () => {
    const h = makeHarness({ sessions: [{ id: 'manual' }] })
    const result = await deleteAutomationWithHistoricalSessions('auto-1', h.deps)
    expect(result).toEqual({ deleted: true, deletedHistoricalSessionCount: 0, failedHistoricalSessionCount: 0 })
  })
})
