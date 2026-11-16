/**
 * 输入框额度胶囊的展示辅助（纯函数）。
 *
 * 只做格式化与窗口筛选：缺少的窗口返回空数组，不用 0% 伪造。
 */

import type { PlanQuotaSource, PlanQuotaWindow } from '@proma/shared'

/** 5 小时 / 每周窗口的紧凑标签。 */
export function formatPlanQuotaWindowLabel(window: PlanQuotaWindow): string {
  if (window.type === '5h') return '5H'
  if (window.type === 'weekly') return '周'
  return window.label
}

/** 窗口剩余值：优先使用供应商提供的余额文案。 */
export function formatPlanQuotaWindowValue(window: PlanQuotaWindow): string {
  return window.remainingLabel ?? `${window.remainingPercent}%`
}

/**
 * 距离重置的紧凑倒计时。
 *
 * 缺少/resetAt 非法时返回 null；已过期时提示等待下一次刷新。
 */
export function formatPlanQuotaCountdown(
  resetAt: number | undefined,
  now: number = Date.now(),
): string | null {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return null
  const remaining = resetAt - now
  if (remaining <= 0) return '待刷新'
  if (remaining < 60_000) return '<1分'

  const totalMinutes = Math.ceil(remaining / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}分`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes > 0 ? `${totalHours}时${minutes}分` : `${totalHours}时`

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `${days}天${hours}时` : `${days}天`
}

/** 胶囊内优先展示 5H 与周窗口；没有时退回供应商自定义窗口（最多一个）。 */
export function selectPlanQuotaIslandWindows(source: PlanQuotaSource): PlanQuotaWindow[] {
  const primary = [
    source.windows.find((window) => window.type === '5h'),
    source.windows.find((window) => window.type === 'weekly'),
  ].filter((window): window is PlanQuotaWindow => window !== undefined)
  if (primary.length > 0) return primary
  return source.windows.slice(0, 1)
}

/** 来源的悬停摘要：渠道、档位与最近更新时间。 */
export function formatPlanQuotaSourceSummary(source: PlanQuotaSource): string {
  const parts = [source.label]
  const plan = [source.planName, source.tier]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' · ')
  if (plan) parts.push(plan)
  if (source.stale) parts.push('上次成功数据')
  if (source.error) parts.push('额度暂不可用')
  parts.push(`更新于 ${formatPlanQuotaUpdatedAt(source.updatedAt)}`)
  return parts.join(' · ')
}

/** 本地时间：月/日 时:分。 */
export function formatPlanQuotaUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
