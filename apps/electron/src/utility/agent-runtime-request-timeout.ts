import { AGENT_RUNTIME_METHODS, DELEGATION_WAIT_RPC_GRACE_MS, normalizeDelegationWaitSeconds } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
// AskUserQuestion 属于用户主导的自由文本交互；两分钟不足以完成输入。
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000

/**
 * Utility Process 请求主进程的等待时间。
 * 只对已知长等待能力设置专属期限，不放宽其他跨进程调用的故障检测。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number {
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL
    && (payload as { toolName?: unknown } | null)?.toolName === 'AskUserQuestion'
  ) {
    return ASK_USER_QUESTION_TIMEOUT_MS
  }
  const request = payload as { toolName?: unknown; input?: { timeoutSeconds?: unknown } } | null
  if (method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL && request?.toolName === 'mcp__collaboration__wait_for_delegations') {
    return normalizeDelegationWaitSeconds(request.input?.timeoutSeconds) * 1000 + DELEGATION_WAIT_RPC_GRACE_MS
  }
  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
