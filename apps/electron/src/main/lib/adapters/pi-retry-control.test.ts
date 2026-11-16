import { describe, expect, test } from 'bun:test'
import { createPiRetryTerminalGate, createPiSummarizationRetryMapper, mapPiNativeRetryEvent } from './pi-retry-control'

const context = { runStartedAt: 123 }

describe('Pi 重试可见性与终态门控', () => {
  test('Given 第一次长请求失败 When 原生恢复 Then 立即显示重试而非静默五次', () => {
    expect(mapPiNativeRetryEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: 'Request timed out.' }, context, 456)).toMatchObject([
      { status: 'starting', attempt: 1, maxAttempts: 2, runStartedAt: 123, scheduledAt: 456, delaySeconds: 1 },
    ])
  })
  test('Given 已显示第一次重试 When 成功或失败 Then UI均能退出等待', () => {
    expect(mapPiNativeRetryEvent({ type: 'auto_retry_end', attempt: 1, success: true }, context)).toMatchObject([{ status: 'cleared' }])
    expect(mapPiNativeRetryEvent({ type: 'auto_retry_end', attempt: 1, success: false, finalError: 'unavailable' }, context)).toMatchObject([{ status: 'failed' }])
  })
  test('Given 重试开始 When 映射 Then 附带稳定 reasonKind', () => {
    expect(mapPiNativeRetryEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1000,
      errorMessage: 'read ECONNRESET',
    }, context, 456)).toMatchObject([{ status: 'starting', reasonKind: 'connection' }])
  })
  test('Given 用户取消 When 重试结束 Then 返回 cancelled 而不是 failed', () => {
    expect(mapPiNativeRetryEvent({
      type: 'auto_retry_end',
      attempt: 1,
      success: false,
      finalError: 'Retry cancelled',
    }, context)).toMatchObject([{ status: 'cancelled', reason: 'Retry cancelled' }])
  })
  test('Given 摘要重试 When 开始并结束 Then 复用UI且不遗留状态', () => {
    const map = createPiSummarizationRetryMapper()
    expect(map({ type: 'summarization_retry_finished' }, context)).toEqual([])
    expect(map({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: 'Request timed out.' }, context)).toMatchObject([{ status: 'starting', attempt: 1 }])
    expect(map({ type: 'summarization_retry_finished' }, context)).toMatchObject([{ status: 'cleared', attempt: 1 }])
    expect(map({ type: 'summarization_retry_finished' }, context)).toEqual([])
  })
  test('Given 可恢复错误 When 尚在重试 Then 不泄漏终态且预算耗尽后正常收束', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('failed attempt')
    expect(gate.settle(true)).toBeUndefined()
    gate.defer('failure budget reached')
    expect(gate.settle(false)).toBe('failure budget reached')
    expect(gate.peek()).toBeUndefined()
  })
})
