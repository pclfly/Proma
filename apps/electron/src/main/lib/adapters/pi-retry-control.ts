import type { RetryAttempt } from '@proma/shared'
import {
  classifyModelFailure,
  type ModelFailureReasonKind,
} from '../network/retry-classifier'

/** 从第一次重试就展示；一次网络等待可能已有数分钟，不能再静默五轮。 */
export const PI_RETRY_VISIBILITY_THRESHOLD = 0

/** 将 Pi native retry 与当前 renderer stream 绑定，拒绝迟到事件污染下一轮。 */
export interface PiRetryEventContext {
  runStartedAt: number
}

interface PiRetryMetadata {
  attempt: number
  maxAttempts: number
  totalAttempt: number
  maxTotalAttempts: number
  runStartedAt: number
}

export type PiRetryUpdate =
  | ({
      status: 'starting'
      delaySeconds: number
      reason: string
      reasonKind: ModelFailureReasonKind
      scheduledAt: number
    } & PiRetryMetadata)
  | ({ status: 'attempt'; attemptData: RetryAttempt } & PiRetryMetadata)
  | ({ status: 'cleared' } & PiRetryMetadata)
  | ({ status: 'failed'; attemptData: RetryAttempt } & PiRetryMetadata)
  | ({ status: 'cancelled'; reason: string; reasonKind: ModelFailureReasonKind } & PiRetryMetadata)

type PiNativeRetryDetails = {
  attempt: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
}

type PiNativeRetryEvent =
  | ({ type: 'auto_retry_start' } & PiNativeRetryDetails)
  | ({ type: 'auto_retry_end'; success: boolean; finalError?: string } & PiNativeRetryDetails)

/**
 * Pi native retry 的终态事件门控。
 *
 * Pi 在判定可重试时会先结束一次失败的 agent loop，再在同一 transcript 上 continue。
 * 在确认 `willRetry` 前，调用方不能把 error 或 result 当作最终状态交给外层编排器。
 */
export function createPiRetryTerminalGate<T>(): {
  defer: (error: T) => void
  peek: () => T | undefined
  settle: (willRetry: boolean) => T | undefined
} {
  let pendingError: T | undefined

  return {
    defer(error) {
      pendingError = error
    },
    peek() {
      return pendingError
    },
    settle(willRetry) {
      const terminalError = willRetry ? undefined : pendingError
      pendingError = undefined
      return terminalError
    },
  }
}

function retryMetadata(event: PiNativeRetryDetails, context: PiRetryEventContext): PiRetryMetadata {
  return {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts ?? event.attempt,
    totalAttempt: event.attempt,
    maxTotalAttempts: event.maxAttempts ?? event.attempt,
    runStartedAt: context.runStartedAt,
  }
}

function retryAttempt(event: PiNativeRetryDetails, timestamp: number, errorMessage: string): RetryAttempt {
  return {
    attempt: event.attempt,
    totalAttempt: event.attempt,
    maxTotalAttempts: event.maxAttempts ?? event.attempt,
    timestamp,
    reason: errorMessage,
    reasonKind: classifyPiRetryReason(errorMessage),
    errorMessage,
    // 这里记录的是本次 retry 实际开始前已经等待的退避时间。
    delaySeconds: (event.delayMs ?? 0) / 1_000,
  }
}

/** Pi 暴露连续失败段的attempt；累计失败上限由请求预算独立管理。 */
function shouldExposePiRetry(event: PiNativeRetryDetails): boolean {
  return event.attempt > PI_RETRY_VISIBILITY_THRESHOLD
}

/**
 * 将 Pi native retry 生命周期转换为 Proma UI 已识别的 retry 事件。
 * 从第一次失败恢复就显示；最终未恢复时，终态assistant error仍会正常展示。
 */
export function mapPiNativeRetryEvent(
  event: PiNativeRetryEvent,
  context: PiRetryEventContext,
  timestamp = Date.now(),
): PiRetryUpdate[] {
  if (!shouldExposePiRetry(event)) return []

  const metadata = retryMetadata(event, context)

  if (event.type === 'auto_retry_start') {
    const reason = event.errorMessage ?? '未知错误'
    return [{
      status: 'starting',
      ...metadata,
      scheduledAt: timestamp,
      delaySeconds: (event.delayMs ?? 0) / 1_000,
      reason,
      reasonKind: classifyPiRetryReason(reason),
    }]
  }

  if (event.type === 'auto_retry_end' && event.success) {
    return [{ status: 'cleared', ...metadata }]
  }

  const error = event.type === 'auto_retry_end' ? event.finalError ?? '未知错误' : 'Retry cancelled'
  // Pi 在用户取消时也走 auto_retry_end；终态必须告诉 UI 是取消而不是失败。
  if (event.type === 'auto_retry_end' && /(?:retry\s+)?cancelled/i.test(error)) {
    return [{
      status: 'cancelled',
      ...metadata,
      reason: error,
      reasonKind: classifyPiRetryReason(error),
    }]
  }
  return [{
    status: 'failed',
    ...metadata,
    attemptData: retryAttempt(event, timestamp, error),
  }]
}

/** 摘要重试与普通请求不同，finished没有attempt；保留本段元数据供UI结束指示。 */
export function createPiSummarizationRetryMapper() {
  let pending: PiNativeRetryDetails | undefined
  return (event:
    | ({ type: 'summarization_retry_scheduled' } & PiNativeRetryDetails)
    | { type: 'summarization_retry_finished' },
  context: PiRetryEventContext, timestamp = Date.now()): PiRetryUpdate[] => {
    if (event.type === 'summarization_retry_scheduled') {
      pending = event
      return mapPiNativeRetryEvent({ ...event, type: 'auto_retry_start' }, context, timestamp)
    }
    if (!pending) return []
    const previous = pending
    pending = undefined
    // 只清除重试指示；摘要成功/失败仍由compaction_end报告，不能据此伪造成功。
    return mapPiNativeRetryEvent({ ...previous, type: 'auto_retry_end', success: true }, context, timestamp)
  }
}

/** 供日志/UI 展示的重试原因；与 installPromaRetryClassifier 共用同一分类器。 */
export function classifyPiRetryReason(errorMessage: string): ModelFailureReasonKind {
  return classifyModelFailure(errorMessage).reasonKind
}

interface RetryableErrorSession {
  _isRetryableError?: (message: unknown) => boolean
}

/**
 * 在 Pi session 上覆盖 `_isRetryableError`，让 SDK 原生 retry 使用 Proma 的分类器。
 *
 * Pi 的默认判断只看少量通用文案，无法识别账单类 429、Chromium 错误码和
 * 流中断细分。覆盖后仍保留 Pi 原始判断作为 `piRetryable` 输入，避免收紧
 * 官方的可重试范围。
 */
export function installPromaRetryClassifier(session: unknown): boolean {
  if (!session || typeof session !== 'object') return false
  const target = session as RetryableErrorSession
  const original = target._isRetryableError
  if (typeof original !== 'function') return false

  target._isRetryableError = function promaRetryClassifier(this: unknown, message: unknown): boolean {
    const piRetryable = original.call(this, message)
    if (!message || typeof message !== 'object') return piRetryable
    const record = message as { errorMessage?: unknown; stopReason?: unknown }
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage : undefined
    if (record.stopReason !== 'error' || !errorMessage) return piRetryable
    return classifyModelFailure(errorMessage, piRetryable).retryable
  }
  return true
}
