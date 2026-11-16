import { describe, expect, test } from 'bun:test'
import { isRetryableAssistantError, isContextOverflow, retryAssistantCall } from '@earendil-works/pi-ai/compat'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createPiRequestFailureBudget, PI_REQUEST_FAILURE_BUDGET_CODE } from './pi-request-failure-budget'

function message(stopReason: AssistantMessage['stopReason'] = 'error', errorMessage = 'Request timed out.'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: '已有正文' }], api: 'openai-responses', provider: 'openai', model: 'gpt-4o', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, ...(stopReason === 'error' && { errorMessage }) }
}

describe('Pi 单个用户任务累计失败预算', () => {
  test('Given 失败后有成功工具回合 When 再失败 Then 不重置累计次数', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
    expect(budget.recordResult(message(), 10).errorMessage).toBe('Request timed out.')
    const success = message('toolUse')
    expect(budget.recordResult(success, 60_000)).toBe(success)
    budget.recordResult(message(), 10)
    const final = budget.recordResult(message(), 10)
    expect(final.errorMessage).toContain(PI_REQUEST_FAILURE_BUDGET_CODE)
    expect(final.content).toEqual(message().content)
    expect(isRetryableAssistantError(final)).toBe(false)
    expect(budget.getState()).toMatchObject({ failedRequests: 3, failedDurationMs: 30, exhausted: true })
    expect(() => budget.assertCanRequest()).toThrow(PI_REQUEST_FAILURE_BUDGET_CODE)
  })

  test('Given 两次五分钟失败 When 累计失败等待达到10分钟 Then 不再重试', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
    budget.recordResult(message(), 300_000)
    const terminal = budget.recordResult(message(), 300_000)
    expect(terminal.errorMessage).toContain(PI_REQUEST_FAILURE_BUDGET_CODE)
    expect(budget.getState()).toMatchObject({ failedRequests: 2, failedDurationMs: 600_000 })
    expect(isRetryableAssistantError(terminal)).toBe(false)
  })

  test('Given 长时间健康请求或用户取消 When 结算 Then 不消耗失败时间预算', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
    const success = message('stop')
    const aborted = message('aborted')
    expect(budget.recordResult(success, 3_600_000)).toBe(success)
    expect(budget.recordResult(aborted, 3_600_000)).toBe(aborted)
    expect(budget.getState()).toMatchObject({ failedRequests: 0, failedDurationMs: 0, exhausted: false })
  })

  test('Given 确定性错误或上下文超限 When 结算 Then 保留错误且不抢占原生压缩恢复', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
    for (const text of ['invalid api key', 'maximum context length exceeded']) {
      const error = message('error', text)
      expect(budget.recordResult(error, 100)).toBe(error)
    }
    expect(budget.getState().failedRequests).toBe(0)
  })

  test('Given 预算耗尽 When 显式新用户任务reset Then 新任务可正常请求', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow }, { maxFailedRequests: 1 })
    budget.recordResult(message(), 50)
    budget.reset()
    expect(() => budget.assertCanRequest()).not.toThrow()
    expect(budget.getState()).toMatchObject({ failedRequests: 0, failedDurationMs: 0, exhausted: false })
  })

  test('Given 原生14次重试策略 When 统一终态记账 Then 第3次失败结束且不重投prompt', async () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
    let calls = 0
    const final = await retryAssistantCall(async () => {
      budget.assertCanRequest()
      calls++
      return budget.recordResult(message(), 1)
    }, { enabled: true, maxRetries: 14, baseDelayMs: 0 }, undefined)
    expect(calls).toBe(3)
    expect(final.errorMessage).toContain(PI_REQUEST_FAILURE_BUDGET_CODE)
    expect(final.stopReason).toBe('error')
  })

  test('Given 预算错误本身 When 被再次观察 Then 不重复计数且不泄露原始错误', () => {
    const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow }, { maxFailedRequests: 1 })
    const terminal = budget.recordResult(message('error', '502: upstream private diagnostic'), 100)
    expect(terminal.errorMessage).not.toContain('private diagnostic')
    expect(budget.recordResult(terminal, 100)).toBe(terminal)
    expect(budget.getState().failedRequests).toBe(1)
  })
})

test('Given 已有两次瞬态失败 When 同时匹配500和overflow Then 保留溢出供原生压缩且不耗失败预算', () => {
  const budget = createPiRequestFailureBudget({ isRetryable: isRetryableAssistantError, isContextOverflow })
  budget.recordResult(message(), 1)
  budget.recordResult(message(), 1)
  const overflow = message('error', '500: context_length_exceeded')
  expect(isRetryableAssistantError(overflow)).toBe(true)
  expect(isContextOverflow(overflow)).toBe(true)
  expect(budget.recordResult(overflow, 600_000)).toBe(overflow)
  expect(budget.getState()).toMatchObject({ failedRequests: 2, exhausted: false })
})
