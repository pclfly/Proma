import { describe, expect, test } from 'bun:test'
import { budgetDelegationResults } from './agent-collaboration-result-budget'

describe('协作结果按预算投影', () => {
  test('Given 多个超长结果 When 总预算不足 Then 公平分配且不修改原文与状态', () => {
    const input = { delegations: [
      { delegationId: 'a', status: 'completed', resultSummary: 'A'.repeat(20000) },
      { delegationId: 'b', status: 'failed', error: 'quota', resultSummary: 'B'.repeat(20000) },
    ] }
    const result = budgetDelegationResults(input, { totalChars: 100, perResultChars: 80 })
    const items = result.delegations as typeof input.delegations
    expect(items.map((item) => item.resultSummary.length)).toEqual([50, 50])
    expect(items[1]?.status).toBe('failed')
    expect(items[1]?.error).toBe('quota')
    expect(input.delegations[0]?.resultSummary.length).toBe(20000)
    expect(result.resultBudget).toMatchObject({ returnedChars: 100, truncatedResults: 2 })
  })
  test('Given 一个短结果 When 分配预算 Then 剩余额度让给其他结果', () => {
    const result = budgetDelegationResults({ delegations: [{ resultSummary: 'abc' }, { resultSummary: 'x'.repeat(100) }] }, { totalChars: 20, perResultChars: 20 })
    expect(result.resultBudget.returnedChars).toBe(20)
    expect(result.delegations[1]?.resultSummary.length).toBe(17)
  })
  test('Given 精读offset When 请求下一页 Then 包含定位与裁剪信息且无50K预截断', () => {
    const result = budgetDelegationResults({ delegation: { resultSummary: 'a'.repeat(60000) + 'TAIL' } }, { totalChars: 20, perResultChars: 20, offset: 60000 })
    expect(result.delegation.resultSummary).toBe('TAIL')
    expect(result.delegation.resultRead).toMatchObject({ offset: 60000, totalChars: 60004, truncated: false, nextOffset: null })
  })
  test('Given emoji与空预算 When 裁剪 Then 不拆代理对且允许仅取元数据', () => {
    const result = budgetDelegationResults({ delegation: { resultSummary: 'A😀B' } }, { totalChars: 2, perResultChars: 2 })
    expect(result.delegation.resultSummary).toBe('A')
    expect(result.delegation.resultRead.nextOffset).toBe(1)
    expect(budgetDelegationResults({ delegation: { resultSummary: 'abc' } }, { totalChars: 0 }).delegation.resultSummary).toBe('')
  })
  test('Given 超大或无效请求 When 规范化 Then 强制上限且details不保留原文', () => {
    const result = budgetDelegationResults({ delegation: { resultSummary: 'x'.repeat(200000) } }, { totalChars: Infinity, perResultChars: 999999 })
    expect(result.resultBudget.returnedChars).toBeLessThanOrEqual(64000)
    expect(JSON.stringify(result).length).toBeLessThan(65000)
  })
})

test('Given 超长阻塞问题 When 请求0正文预算 Then 保留身份但只返回有界交互预览', () => {
  const payload = { pendingBlockedEvents: Array.from({ length: 10 }, (_, i) => ({ blockedEventId: `id-${i}`, requestId: `request-${i}`, askUserQuestions: [{ question: 'Q'.repeat(100000), options: [{ label: 'choose', description: 'D'.repeat(100000) }] }] })) }
  const result = budgetDelegationResults(payload, { totalChars: 0 })
  expect(result.resultBudget.blockedPreviewTruncated).toBe(true)
  expect(result.resultBudget.blockedPreviewChars).toBeLessThanOrEqual(8000)
  expect(JSON.stringify(result).length).toBeLessThan(12000)
  expect(result.pendingBlockedEvents[0]!.blockedEventId).toBe('id-0')
  expect(payload.pendingBlockedEvents[0]!.askUserQuestions[0]!.question.length).toBe(100000)
})

test('Given 前一问题耗尽预览预算 When 后一真实权限事件投影 Then 标识及工具名保留', () => {
  const permission = { id: 'permission-second', delegationId: 'child-delegation', childSessionId: 'child-session', type: 'permission', permissionRequestId: 'permission-request', permissionToolName: 'Bash', resolved: false }
  const result = budgetDelegationResults({ pendingBlockedEvents: [
    { id: 'question', askUserRequestId: 'ask-id', askUserQuestions: Array.from({ length: 10 }, () => ({ question: 'Q'.repeat(5000) })) },
    permission,
  ] })
  expect(result.resultBudget.blockedPreviewTruncated).toBe(true)
  expect(result.pendingBlockedEvents[1]).toEqual(permission)
  expect(result.pendingBlockedEvents[0]).toMatchObject({ askUserRequestId: 'ask-id' })
})
