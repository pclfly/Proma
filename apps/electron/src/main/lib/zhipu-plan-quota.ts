/**
 * 智谱 Coding Plan 额度响应解析（纯函数）。
 *
 * 兼容两类计划：
 * - 窗口制：`TOKENS_LIMIT` 表示 5 小时 / 每周的 token 额度；
 * - 积分制：个人与团队计划都可能返回积分余额，不再折算成 token 百分比。
 *
 * 兼容的积分载荷（按优先级）：
 * - `data.limits[]` 中 `type` 含 CREDIT/POINT/BALANCE 的项；
 * - `limit.credits` / `limit.credit`；
 * - `data.credits` / `data.credit` / `data.plan.credits` / 顶层 `credits`。
 *
 * 解析器不发起请求、不读取凭据；查询与鉴权仍由 channel-manager 负责。
 */

import type {
  ChannelPlanQuotaCredits,
  ChannelPlanQuotaResult,
  ChannelPlanQuotaWindow,
  ProviderType,
} from '@proma/shared'

export interface ZhipuQuotaCreditsPayload {
  total?: number | string
  remaining?: number | string
  available?: number | string
  used?: number | string
  currentValue?: number | string
  unit?: string
  nextResetTime?: number | string
  resetTime?: number | string
}

export interface ZhipuQuotaLimitItem {
  /** TIME_LIMIT / TOKENS_LIMIT / CREDIT_LIMIT 等；保留字符串以兼容新类型。 */
  type: string
  unit?: number
  number?: number
  percentage?: number
  remaining?: number
  available?: number
  total?: number
  usage?: number
  currentValue?: number
  nextResetTime?: number
  credits?: ZhipuQuotaCreditsPayload
  credit?: ZhipuQuotaCreditsPayload
  usageDetails?: Array<{
    modelCode: string
    usage: number
  }>
}

export interface ZhipuQuotaResponse {
  code?: number
  msg?: string
  success?: boolean
  data?: {
    limits?: ZhipuQuotaLimitItem[]
    level?: string
    planName?: string
    credits?: ZhipuQuotaCreditsPayload
    credit?: ZhipuQuotaCreditsPayload
    plan?: {
      credits?: ZhipuQuotaCreditsPayload
      credit?: ZhipuQuotaCreditsPayload
    }
  }
  credits?: ZhipuQuotaCreditsPayload
  credit?: ZhipuQuotaCreditsPayload
}

const CREDIT_LIMIT_TYPE_PATTERN = /CREDIT|POINT|BALANCE/i

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizeZhipuQuotaTimestamp(value?: number | string): number | undefined {
  if (value == null || value === '') return undefined
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return undefined
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
}

function planQuotaResetAt(value?: number | string): Pick<ChannelPlanQuotaWindow, 'resetAt'> {
  const resetAt = normalizeZhipuQuotaTimestamp(value)
  return resetAt ? { resetAt } : {}
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 从单个 limit 或 data 层提取积分载荷。 */
function pickCreditsPayload(source: {
  type?: string
  remaining?: number
  available?: number
  total?: number
  usage?: number
  currentValue?: number
  nextResetTime?: number
  credits?: ZhipuQuotaCreditsPayload
  credit?: ZhipuQuotaCreditsPayload
}): ZhipuQuotaCreditsPayload | undefined {
  if (source.credits) return source.credits
  if (source.credit) return source.credit
  if (source.type && CREDIT_LIMIT_TYPE_PATTERN.test(source.type)) {
    return {
      total: source.total ?? source.usage,
      remaining: source.remaining,
      available: source.available,
      used: source.currentValue,
      nextResetTime: source.nextResetTime,
    }
  }
  return undefined
}

interface NormalizedCredits {
  credits: ChannelPlanQuotaCredits
  window: ChannelPlanQuotaWindow
}

function normalizeCredits(
  payload: ZhipuQuotaCreditsPayload,
  team: boolean,
): NormalizedCredits | null {
  const remaining = toFiniteNumber(payload.remaining) ?? toFiniteNumber(payload.available)
  if (remaining === undefined) return null

  const used = toFiniteNumber(payload.used) ?? toFiniteNumber(payload.currentValue) ?? 0
  const reportedTotal = toFiniteNumber(payload.total)
  const total = reportedTotal !== undefined && reportedTotal > 0
    ? reportedTotal
    : Math.max(0, remaining + used)
  const remainingPercent = total > 0 ? clampPercent((remaining / total) * 100) : 0
  const unit = payload.unit?.trim() || '积分'
  const remainingLabel = `${remaining} ${unit}`

  return {
    credits: {
      remaining,
      total,
      unit,
      remainingLabel,
      ...planQuotaResetAt(payload.nextResetTime ?? payload.resetTime),
    },
    window: {
      type: 'custom',
      label: team ? '团队积分' : '积分余额',
      remainingPercent,
      usedPercent: clampPercent(100 - remainingPercent),
      remainingLabel,
      showProgress: total > 0,
      ...planQuotaResetAt(payload.nextResetTime ?? payload.resetTime),
    },
  }
}

/**
 * 解析智谱额度响应。
 *
 * @param data 智谱 `api/monitor/usage/quota/limit` 响应
 * @param planName Plan 展示名（个人 / 团队）
 * @param provider 渠道 provider 类型
 * @param now 查询时间戳，仅测试注入
 */
export function parseZhipuQuotaData(
  data: ZhipuQuotaResponse,
  planName: string,
  provider: ProviderType = 'zhipu-coding',
  now: number = Date.now(),
): ChannelPlanQuotaResult {
  const unsupported = (message: string): ChannelPlanQuotaResult => ({
    supported: false,
    provider,
    windows: [],
    updatedAt: now,
    message,
  })

  if (!data.success || data.code !== 200) {
    return unsupported(data.msg || '智谱 Coding Plan 额度查询失败')
  }

  const team = provider === 'zhipu-coding-team'
  const limits = data.data?.limits ?? []
  const windows: ChannelPlanQuotaWindow[] = []
  const tokenLimits = limits
    .filter((item) => item.type === 'TOKENS_LIMIT')
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftReset = normalizeZhipuQuotaTimestamp(left.item.nextResetTime)
      const rightReset = normalizeZhipuQuotaTimestamp(right.item.nextResetTime)
      if (leftReset && rightReset && leftReset !== rightReset) {
        return leftReset - rightReset
      }
      return left.index - right.index
    })

  for (const { item, index } of tokenLimits) {
    const used = clampPercent(item.percentage ?? 0)
    const type = item.unit === 3
      ? '5h'
      : item.unit === 6
        ? 'weekly'
        : item.unit == null && index === 0
          ? '5h'
          : item.unit == null && index === 1
            ? 'weekly'
            : undefined
    if (!type) continue
    windows.push({
      type,
      label: type === '5h' ? '每 5 小时' : '每周额度',
      remainingPercent: clampPercent(100 - used),
      usedPercent: used,
      ...planQuotaResetAt(item.nextResetTime),
    })
  }

  const timeLimit = limits.find((item) => item.type === 'TIME_LIMIT')
  if (timeLimit) {
    const remainingCount = Number(timeLimit.remaining ?? 0)
    const totalCount = Number(timeLimit.usage ?? 0)
    const usedCount = Number(timeLimit.currentValue ?? (totalCount > 0 ? totalCount - remainingCount : 0))
    const total = totalCount > 0 ? totalCount : remainingCount + usedCount
    const remainingPercent = total > 0 ? (remainingCount / total) * 100 : 0
    windows.push({
      type: 'custom',
      label: 'MCP 每月',
      remainingPercent: clampPercent(remainingPercent),
      usedPercent: clampPercent(100 - remainingPercent),
    })
  }

  // 积分制：优先读 limit 上的积分字段，其次读 data / 顶层积分对象。
  const creditPayload = limits
    .map((item) => pickCreditsPayload(item))
    .find((payload): payload is ZhipuQuotaCreditsPayload => payload !== undefined)
    ?? data.data?.credits
    ?? data.data?.credit
    ?? data.data?.plan?.credits
    ?? data.data?.plan?.credit
    ?? data.credits
    ?? data.credit
  const normalizedCredits = creditPayload ? normalizeCredits(creditPayload, team) : null
  if (normalizedCredits) windows.push(normalizedCredits.window)

  if (windows.length === 0) {
    return unsupported('智谱 Coding Plan 未返回窗口额度数据')
  }

  return {
    supported: true,
    provider,
    planName,
    windows,
    ...(normalizedCredits ? { credits: normalizedCredits.credits } : {}),
    updatedAt: now,
  }
}
