/**
 * Cloud 用量服务（纯逻辑部分）
 *
 * 从官方 0.22.0 `src/main/lib/cloud-usage-service.ts` 提取：
 * - 北京时间日期格式化（Intl Asia/Shanghai）
 * - ISO 日期偏移
 * - Agent Token 活跃度查询区间
 *
 * 真实 `/me/*` 请求、TTL 缓存与 IPC 注册 deferred。
 */

import type {
  CloudAgentTokenActivity,
  CloudAgentTurnUsage,
  CloudAgentUsageLog,
  CloudCombinedUsageLog,
  CloudSpeechUsageLog,
  CloudToolUsageLog,
  CloudUsageLog,
  CloudUsagePage,
  CloudUsageQuery,
} from '@proma/cloud'
import type { CloudServiceResult } from './cloud-service-types'

/** 北京时间（Asia/Shanghai）的 YYYY-MM-DD */
export function getBeijingIsoDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

/**
 * ISO 日期偏移（UTC 语义）。
 *
 * 与官方一致：输入非法时会抛出 RangeError（toISOString）。
 */
export function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export interface CloudAgentTokenActivityRange {
  today: string
  historyStartDate: string
  historyEndDate: string
}

/**
 * Agent Token 活跃度查询区间：历史 364 天 + 当日单独查询。
 */
export function getAgentTokenActivityRange(today: string): CloudAgentTokenActivityRange {
  return {
    today,
    historyStartDate: shiftIsoDate(today, -364),
    historyEndDate: shiftIsoDate(today, -1),
  }
}

/** 用量服务类型契约；实现留给后续批次。 */
export interface CloudUsageService {
  getUsageLogs(params?: CloudUsageQuery): Promise<CloudServiceResult<CloudUsagePage<CloudUsageLog>>>
  getCombinedUsageLogs(params?: CloudUsageQuery): Promise<CloudServiceResult<CloudUsagePage<CloudCombinedUsageLog>>>
  getToolUsageLogs(params?: CloudUsageQuery): Promise<CloudServiceResult<CloudUsagePage<CloudToolUsageLog>>>
  getSpeechUsageLogs(params?: CloudUsageQuery): Promise<CloudServiceResult<CloudUsagePage<CloudSpeechUsageLog>>>
  getAgentUsageLogs(params?: CloudUsageQuery): Promise<CloudServiceResult<CloudUsagePage<CloudAgentUsageLog>>>
  getAgentTokenActivity(): Promise<CloudServiceResult<CloudAgentTokenActivity>>
  getAgentTurnUsage(turnId: string): Promise<CloudServiceResult<CloudAgentTurnUsage>>
}
