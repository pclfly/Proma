import type { AssistantMessage } from '@earendil-works/pi-ai'

export const PI_REQUEST_FAILURE_BUDGET_CODE = 'proma_request_failure_budget_exhausted'

interface FailureClassifiers {
  isRetryable(message: AssistantMessage): boolean
  isContextOverflow(message: AssistantMessage): boolean
}

interface FailureBudgetOptions {
  maxFailedRequests?: number
  maxFailedDurationMs?: number
}

interface FailureBudgetState {
  failedRequests: number
  failedDurationMs: number
  exhausted: boolean
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 一个显式用户任务共用：成功工具回合、压缩和自动续接都不能重置累计失败预算。
 * 只在provider可信终态记账；不重投prompt、不计工具/用户等待、不改变已完成副作用。
 */
export function createPiRequestFailureBudget(
  classifiers: FailureClassifiers,
  options: FailureBudgetOptions = {},
) {
  const maxFailedRequests = positiveLimit(options.maxFailedRequests, 3)
  const maxFailedDurationMs = positiveLimit(options.maxFailedDurationMs, 10 * 60_000)
  let failedRequests = 0
  let failedDurationMs = 0
  let exhaustedMessage: string | undefined

  return {
    assertCanRequest(): void {
      if (exhaustedMessage) throw new Error(exhaustedMessage)
    },
    recordResult(message: AssistantMessage, durationMs: number): AssistantMessage {
      // SDK先恢复上下文溢出，再考虑网络重试；混有500状态码的overflow也不得改写。
      if (message.stopReason !== 'error' || message.errorMessage?.startsWith(PI_REQUEST_FAILURE_BUDGET_CODE)
        || classifiers.isContextOverflow(message) || !classifiers.isRetryable(message)) return message
      failedRequests++
      failedDurationMs += Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
      if (failedRequests < maxFailedRequests && failedDurationMs < maxFailedDurationMs) return message
      exhaustedMessage ??= `${PI_REQUEST_FAILURE_BUDGET_CODE}: 本次任务的模型请求已累计失败${failedRequests}次，失败等待约${Math.ceil(failedDurationMs / 1000)}秒，已达到自动恢复上限并停止。已完成的工具结果保留，不会自动重放；请检查渠道连接，或用简短交接在新会话继续。`
      // 不拼接原始provider错误：其中可能有敏感诊断，或被SDK再次识别为可重试。
      return { ...message, errorMessage: exhaustedMessage }
    },
    reset(): void {
      failedRequests = 0
      failedDurationMs = 0
      exhaustedMessage = undefined
    },
    getState(): FailureBudgetState {
      return { failedRequests, failedDurationMs, exhausted: exhaustedMessage !== undefined }
    },
  }
}
