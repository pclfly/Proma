/**
 * Cloud 账单服务（纯逻辑部分）
 *
 * 从官方 0.22.0 `src/main/lib/github-copilot-plan-quota.ts` 与
 * `cloud-billing-service.ts` 提取可安全移植的纯函数：
 * - GitHub Copilot 配额响应解析（含 reset 时间、窗口百分比）
 * - 企业版 GitHub 域 → Copilot 用量 URL
 *
 * 真实账单 / 订阅 / 支付请求与 IPC 注册 deferred。
 */

import type { CloudBalanceCheck, CloudBillingInfo } from '@proma/cloud'
import type { CloudServiceResult } from './cloud-service-types'

/** 官方默认 Copilot 用量端点 */
export const GITHUB_COPILOT_USAGE_URL = 'https://api.github.com/copilot_internal/user'

export interface CloudQuotaWindow {
  type: 'custom'
  label: string
  remainingPercent: number
  usedPercent: number
  /** false 时表示非计量窗口（不展示进度条） */
  showProgress?: boolean
  remainingLabel?: string
  resetAt?: number
}

export interface CloudGithubCopilotPlanQuota {
  supported: boolean
  provider: 'github-copilot'
  planName?: string
  windows: CloudQuotaWindow[]
  updatedAt: number
  message?: string
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function unavailable(message: string, now: number): CloudGithubCopilotPlanQuota {
  return { supported: false, provider: 'github-copilot', windows: [], updatedAt: now, message }
}

function nonMeteredWindow(
  label: string,
  remainingLabel: string,
  resetAt: number | undefined,
): CloudQuotaWindow {
  return {
    type: 'custom',
    label,
    remainingLabel,
    remainingPercent: 0,
    usedPercent: 0,
    showProgress: false,
    resetAt,
  }
}

/**
 * 解析 reset 时间。
 *
 * 只接受 `YYYY-MM-DD` 或带时区的 ISO 时间；逐字段校验避免 2025-02-31 之类
 * 被 Date 自动进位。
 */
export function parseQuotaResetTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (
    !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
    || (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59))
  ) {
    return undefined
  }
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

/** 解析单个计量窗口 */
export function parseQuotaWindow(
  value: unknown,
  label: string,
  resetAt: number | undefined,
): CloudQuotaWindow | undefined {
  const snapshot = objectValue(value)
  if (!snapshot) return undefined
  if (snapshot.unlimited === true) return nonMeteredWindow(label, '不限量', resetAt)

  const entitlement = numberValue(snapshot.entitlement)
  const remaining = numberValue(snapshot.remaining)
  if (entitlement === 0 && remaining === 0) return undefined

  const percent = numberValue(snapshot.percent_remaining)
    ?? (entitlement !== undefined && entitlement > 0 && remaining !== undefined
      ? remaining / entitlement * 100
      : undefined)
  if (percent === undefined || !Number.isFinite(percent)) return undefined

  const remainingPercent = Math.round(Math.max(0, Math.min(100, percent)) * 100) / 100
  return {
    type: 'custom',
    label,
    remainingPercent,
    usedPercent: Math.round((100 - remainingPercent) * 100) / 100,
    ...(entitlement !== undefined && entitlement > 0 && remaining !== undefined
      ? { remainingLabel: `${Math.max(0, remaining)} / ${entitlement}` }
      : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/** Copilot 套餐显示名 */
export function resolveGithubCopilotPlanName(value: unknown): string {
  switch (value) {
    case 'free':
      return 'GitHub Copilot Free'
    case 'individual':
      return 'GitHub Copilot 个人订阅'
    case 'pro':
      return 'GitHub Copilot Pro'
    case 'pro+':
    case 'pro_plus':
      return 'GitHub Copilot Pro+'
    case 'business':
      return 'GitHub Copilot Business'
    case 'enterprise':
      return 'GitHub Copilot Enterprise'
    default:
      return 'GitHub Copilot'
  }
}

/**
 * 解析 Copilot 配额响应。
 *
 * 与官方一致：premium 优先，chat/补全在 snapshots 缺失时回退到
 * monthly_quotas / limited_user_quotas；按量计费时额外插入非计量窗口。
 */
export function parseGithubCopilotPlanQuotaResponse(
  data: unknown,
  now: number = Date.now(),
): CloudGithubCopilotPlanQuota {
  const response = objectValue(data)
  if (!response) return unavailable('GitHub Copilot 额度响应格式错误', now)

  const snapshots = objectValue(response.quota_snapshots)
  const resetAt = parseQuotaResetTimestamp(response.quota_reset_date)
  const windows: CloudQuotaWindow[] = []

  const premium = parseQuotaWindow(snapshots?.premium_interactions, 'Premium', resetAt)
  if (premium) windows.push(premium)

  const monthly = objectValue(response.monthly_quotas)
  const limited = objectValue(response.limited_user_quotas)
  for (const [key, label] of [['chat', 'Chat'], ['completions', '补全']] as const) {
    let window = parseQuotaWindow(snapshots?.[key], label, resetAt)
    const entitlement = numberValue(monthly?.[key])
    const remaining = numberValue(limited?.[key])
    if (
      (!window || window.showProgress === false)
      && entitlement !== undefined
      && entitlement > 0
      && remaining !== undefined
    ) {
      window = parseQuotaWindow({ entitlement, remaining }, label, resetAt)
    }
    if (window) windows.push(window)
  }

  if (response.token_based_billing === true) {
    windows.unshift(nonMeteredWindow('计费方式', '按量计费', resetAt))
  }

  if (windows.length === 0) {
    return unavailable('GitHub Copilot 未返回可用额度数据，内部接口可能已变化', now)
  }

  return {
    supported: true,
    provider: 'github-copilot',
    planName: resolveGithubCopilotPlanName(response.copilot_plan),
    windows,
    updatedAt: now,
  }
}

/**
 * 企业版 GitHub 域 → Copilot 用量 URL。
 *
 * 仅接受 github.com 或 `*.ghe.com`，拒绝路径、端口、超长主机名。
 */
export function resolveGithubCopilotUsageUrl(enterpriseUrl?: string): string | undefined {
  if (!enterpriseUrl) return GITHUB_COPILOT_USAGE_URL
  const match = /^(?:https:\/\/)?(github\.com|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ghe\.com)\/?$/i.exec(enterpriseUrl)
  if (!match?.[1]) return undefined
  const host = match[1].toLowerCase()
  if (host.length > 253 || host.split('.').some((part) => part.length > 63)) return undefined
  const apiHost = host === 'github.com'
    ? 'api.github.com'
    : host.startsWith('api.')
      ? host
      : `api.${host}`
  return `https://${apiHost}/copilot_internal/user`
}

/** 账单服务类型契约；实现留给后续批次。 */
export interface CloudBillingService {
  getBilling(): Promise<CloudServiceResult<CloudBillingInfo>>
  checkBalance(): Promise<CloudServiceResult<CloudBalanceCheck>>
}
