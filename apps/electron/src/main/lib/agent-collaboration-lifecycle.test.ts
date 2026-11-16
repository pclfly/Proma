import { describe, expect, test } from 'bun:test'
import { classifyDelegationCompletion, getFinalAssistantUuid, getAssistantSummary } from './agent-collaboration-lifecycle'
import type { SDKMessage } from '@proma/shared'

const assistant = (uuid: string, text: string, extra: Record<string, unknown> = {}): SDKMessage => ({
  type: 'assistant', uuid, message: { content: [{ type: 'text', text }] }, ...extra,
} as unknown as SDKMessage)

describe('协作运行结果语义', () => {
  test('Given 结束原因 When 分类 Then 错误、停止与无终态证据不误报成功', () => {
    expect(classifyDelegationCompletion({ resultSubtype: 'success' })).toBe('completed')
    expect(classifyDelegationCompletion({ resultSubtype: 'error_max_budget_usd' })).toBe('failed')
    expect(classifyDelegationCompletion({ error: 'quota exceeded' })).toBe('failed')
    expect(classifyDelegationCompletion({ resultErrors: ['timeout'] })).toBe('failed')
    expect(classifyDelegationCompletion({ stoppedByUser: true, error: 'aborted' })).toBe('cancelled')
    expect(classifyDelegationCompletion({})).toBe('interrupted')
  })
  test('Given 旧错误、replay 和新结果 When 选择结果引用 Then 只使用真实正文', () => {
    const old = assistant('old', 'OLD ERROR', { error: { message: 'error' } })
    const replay = assistant('replay', 'REPLAY', { isReplay: true })
    const final = assistant('new', 'NEW FINAL')
    expect(getFinalAssistantUuid(old)).toBeUndefined()
    expect(getFinalAssistantUuid(replay)).toBeUndefined()
    expect(getFinalAssistantUuid(final)).toBe('new')
    expect(getAssistantSummary([old, replay, final], 'new')).toBe('NEW FINAL')
    expect(getAssistantSummary([old, final], 'missing')).toBeUndefined()
  })
})
