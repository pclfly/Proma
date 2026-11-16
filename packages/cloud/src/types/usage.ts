/**
 * Cloud 用量与计费日志类型
 *
 * 官方 0.22.0 的 `/me/*` 日志接口字段未在 bundle 中保留类型声明，
 * 这里只固定已确定使用的查询参数与通用分页外形，其余字段允许后端扩展。
 */

export interface CloudUsageQuery {
  /** 服务端日期过滤（原样透传，官方不做 URL 编码） */
  dateFilter?: string
  page?: number
  pageSize?: number
}

export interface CloudUsageLog {
  id?: string
  model?: string
  createdAt?: string
  inputTokens?: number
  outputTokens?: number
  credits?: number
  cost?: number
  [key: string]: unknown
}

export interface CloudCombinedUsageLog extends CloudUsageLog {
  kind?: string
  [key: string]: unknown
}

export interface CloudToolUsageLog {
  id?: string
  toolName?: string
  createdAt?: string
  [key: string]: unknown
}

export interface CloudSpeechUsageLog {
  id?: string
  createdAt?: string
  durationMs?: number
  [key: string]: unknown
}

export interface CloudAgentUsageLog extends CloudUsageLog {
  turnId?: string
  [key: string]: unknown
}

export interface CloudUsagePage<T> {
  items: T[]
  total?: number
  page?: number
  page_size?: number
  [key: string]: unknown
}

export interface CloudAgentTokenActivityQuery {
  startDate?: string
  endDate?: string
}

export interface CloudAgentTokenActivityPoint {
  date: string
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  [key: string]: unknown
}

export interface CloudAgentTokenActivity {
  items: CloudAgentTokenActivityPoint[]
  startDate?: string
  endDate?: string
  [key: string]: unknown
}

export interface CloudAgentTurnUsage {
  turnId?: string
  credits?: number
  tokens?: number
  [key: string]: unknown
}
