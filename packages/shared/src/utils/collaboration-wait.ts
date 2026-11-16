/** 协作主进程等待与 utility RPC 必须使用同一期限规范化规则。 */
export const DEFAULT_DELEGATION_WAIT_SECONDS = 60 * 60
export const MAX_DELEGATION_WAIT_SECONDS = 2 * 60 * 60
export const DELEGATION_WAIT_RPC_GRACE_MS = 30_000

export function normalizeDelegationWaitSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(value, MAX_DELEGATION_WAIT_SECONDS))
    : DEFAULT_DELEGATION_WAIT_SECONDS
}
