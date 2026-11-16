/**
 * 额度使用信号的轻量总线。
 *
 * agent-service 每轮结束只需发出「用过额度」信号；这里不导入渠道、
 * Electron 或查询实现，避免把整条额度链路塞进它的模块图（也便于测试隔离）。
 */

type PlanQuotaUsageListener = () => void

let listener: PlanQuotaUsageListener | null = null

/** 由额度服务注册；重复注册会覆盖旧监听。 */
export function setPlanQuotaUsageListener(next: PlanQuotaUsageListener | null): void {
  listener = next
}

/** 一轮对话结束后调用。没有订阅者时是无操作。 */
export function notePlanQuotaUsage(): void {
  listener?.()
}
