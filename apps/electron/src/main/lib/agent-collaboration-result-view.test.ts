import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COLLABORATION_RESULT_CHARS,
  MAX_COLLABORATION_RESULT_CHARS,
  asInterruptedDelegationAttempt,
  normalizeDelegationListLimit,
  paginateDelegationResults,
  projectDelegationResults,
  selectDelegationResults,
  validateDelegationResultReadOptions,
  type DelegationResultLike,
} from './agent-collaboration-result-view'

function result(
  id: string,
  overrides: Partial<DelegationResultLike> = {},
): DelegationResultLike {
  return {
    delegationId: id,
    attemptId: `attempt-${id}`,
    status: 'completed',
    startedAt: 100,
    goal: '目标',
    resultSummary: '结果',
    ...overrides,
  }
}

describe('协作结果投影', () => {
  test('Given 长短结果 When preview 预算有限 Then 短结果先拿满且长结果公平截断', () => {
    const projected = projectDelegationResults([
      result('short', { resultSummary: 'a'.repeat(10) }),
      result('long', { resultSummary: 'b'.repeat(100) }),
    ], { detail: 'preview', maxResultChars: 50 })
    expect(projected[0]?.resultSummary).toBe('a'.repeat(10))
    expect(projected[0]?.resultSummaryTruncated).toBe(false)
    expect(projected[1]?.resultSummary).toBe('b'.repeat(40))
    expect(projected[1]?.resultSummaryTruncated).toBe(true)
    expect(projected[0]?.resultAvailable).toBe(true)
    expect(projected[0]?.resultSummaryChars).toBe(10)
  })

  test('Given metadata When 目标/错误过长 Then 独立预览上限且正文不返回', () => {
    const projected = projectDelegationResults([
      result('meta', {
        goal: 'g'.repeat(600),
        error: 'e'.repeat(2_100),
        resultSummary: 'hidden',
      }),
    ], { detail: 'metadata', maxResultChars: 0 })
    const view = projected[0]!
    expect(view.resultSummary).toBeUndefined()
    expect(view.resultAvailable).toBe(true)
    expect(String(view.goal)).toHaveLength(501)
    expect(String(view.goal).endsWith('…')).toBe(true)
    expect(String(view.error)).toHaveLength(2_001)
    expect(view.resultSummaryTruncated).toBeUndefined()
  })

  test('Given 大量阻塞事件 When metadata 投影 Then 事件数封顶并标记截断', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `blocked-${index}`,
      type: 'ask_user',
      askUserRequestId: `ask-${index}`,
      askUserQuestions: [{ question: 'q', header: 'h' }],
    }))
    const view = projectDelegationResults([result('blocked', { pendingBlockedEvents: events })], {
      detail: 'metadata',
      maxResultChars: 0,
    })[0]!
    expect(view.pendingBlockedEventsTruncated).toBe(true)
    expect(view.pendingBlockedEvents).toHaveLength(10)
  })

  test('Given 超长问题与选项 When metadata 投影 Then 字符和选项数封顶', () => {
    const longView = projectDelegationResults([result('long', {
      pendingBlockedEvents: [{
        id: 'blocked',
        type: 'ask_user',
        askUserRequestId: 'ask',
        askUserQuestions: [{ question: 'q'.repeat(4_100), header: 'h' }],
      }],
    })], { detail: 'metadata', maxResultChars: 0 })[0]!
    const longEvent = (longView.pendingBlockedEvents as Array<Record<string, unknown>>)[0]!
    const longQuestion = (longEvent.askUserQuestions as Array<Record<string, unknown>>)[0]!
    expect(String(longQuestion.question)).toHaveLength(4_000)
    expect(longView.pendingBlockedEventsTruncated).toBe(true)

    const optionsView = projectDelegationResults([result('options', {
      pendingBlockedEvents: [{
        id: 'blocked',
        type: 'ask_user',
        askUserRequestId: 'ask',
        askUserQuestions: [{
          question: 'q',
          header: 'h',
          options: Array.from({ length: 25 }, (_, index) => ({
            label: `label-${index}`,
            description: 'd',
          })),
        }],
      }],
    })], { detail: 'metadata', maxResultChars: 0 })[0]!
    const optionsEvent = (optionsView.pendingBlockedEvents as Array<Record<string, unknown>>)[0]!
    const optionQuestion = (optionsEvent.askUserQuestions as Array<Record<string, unknown>>)[0]!
    expect(optionQuestion.options).toHaveLength(20)
    expect(optionsView.pendingBlockedEventsTruncated).toBe(true)
  })

  test('Given 当前 scope 引用旧 attempt When 委派已续跑 Then 返回 interrupted 快照而非新结果', () => {
    const current = result('d1', {
      attemptId: 'new-attempt',
      title: '新标题',
      resultSummary: '新结果',
    })
    const selected = selectDelegationResults({
      scope: 'current',
      dependencies: [{
        delegationId: 'd1',
        attemptId: 'old-attempt',
        attemptSnapshot: { title: '旧标题', startedAt: 42 },
      }],
      all: [current, result('missing')],
      includeCompleted: true,
    })
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      delegationId: 'd1',
      attemptId: 'old-attempt',
      title: '旧标题',
      startedAt: 42,
      status: 'interrupted',
    })
    expect(selected[0]?.resultSummary).toBeUndefined()
  })

  test('Given 匹配 attempt When current scope Then 原样返回；includeCompleted=false 只保留 running', () => {
    const running = result('run', { attemptId: 'a1', status: 'running' })
    const completed = result('done', { attemptId: 'a2', status: 'completed' })
    const selected = selectDelegationResults({
      scope: 'current',
      dependencies: [
        { delegationId: 'run', attemptId: 'a1' },
        { delegationId: 'done', attemptId: 'a2' },
      ],
      all: [running, completed],
      includeCompleted: false,
    })
    expect(selected.map((item) => item.delegationId)).toEqual(['run'])
  })

  test('Given history When newest-first 分页 Then 游标稳定跳过同时间戳项', () => {
    const items = [
      result('a', { startedAt: 10 }),
      result('b', { startedAt: 20 }),
      result('c', { startedAt: 20 }),
      result('d', { startedAt: 30 }),
    ]
    const first = paginateDelegationResults(items, { limit: 2, order: 'newest-first' })
    expect(first.items.map((item) => item.delegationId)).toEqual(['d', 'b'])
    expect(first.totalCount).toBe(4)
    const second = paginateDelegationResults(items, {
      limit: 2,
      order: 'newest-first',
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.delegationId)).toEqual(['c', 'a'])
    expect(second.nextCursor).toBeUndefined()
  })

  test('Given input 顺序 When offset 分页 Then 返回稳定 nextCursor', () => {
    const items = [result('a'), result('b'), result('c')]
    const first = paginateDelegationResults(items, { limit: 2 })
    expect(first.items.map((item) => item.delegationId)).toEqual(['a', 'b'])
    expect(first.nextCursor).toBe('2')
    const second = paginateDelegationResults(items, { limit: 2, cursor: first.nextCursor })
    expect(second.items.map((item) => item.delegationId)).toEqual(['c'])
    expect(second.nextCursor).toBeUndefined()
  })

  test('Given 非法参数 When 校验 Then 拒绝 full 多 ID、越界预算和非法游标', () => {
    expect(() => validateDelegationResultReadOptions({ delegationCount: 2, detail: 'full' }))
      .toThrow('detail=full')
    expect(validateDelegationResultReadOptions({ delegationCount: 1, detail: 'full' }).maxResultChars)
      .toBe(MAX_COLLABORATION_RESULT_CHARS)
    expect(validateDelegationResultReadOptions({ delegationCount: 2 }).maxResultChars)
      .toBe(DEFAULT_COLLABORATION_RESULT_CHARS)
    expect(() => normalizeDelegationListLimit(0)).toThrow('limit')
    expect(() => normalizeDelegationListLimit(101)).toThrow('limit')
    expect(() => paginateDelegationResults([result('a')], { cursor: 'x' })).toThrow('cursor')
    expect(() => paginateDelegationResults([result('a')], {
      order: 'newest-first',
      cursor: 'bad',
    })).toThrow('history cursor')
  })

  test('Given 旧 attempt When 依赖未给出快照 Then 保留当前身份并标记 interrupted', () => {
    const interrupted = asInterruptedDelegationAttempt(result('d1', {
      attemptId: 'new',
      title: '标题',
      goal: '目标',
    }), 'old')
    expect(interrupted).toMatchObject({
      delegationId: 'd1',
      attemptId: 'old',
      title: '标题',
      goal: '目标',
      status: 'interrupted',
    })
  })
})
