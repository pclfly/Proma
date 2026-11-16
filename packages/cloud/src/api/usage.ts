/**
 * Cloud 用量 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/usage.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type {
  CloudAgentTokenActivity,
  CloudAgentTokenActivityQuery,
  CloudAgentTurnUsage,
  CloudAgentUsageLog,
  CloudCombinedUsageLog,
  CloudSpeechUsageLog,
  CloudToolUsageLog,
  CloudUsageLog,
  CloudUsagePage,
  CloudUsageQuery,
} from '../types/usage.ts'

/**
 * 构造日志筛选查询串。
 *
 * 官方实现直接拼接未编码参数；这里保持一致以兼容后端既有行为。
 */
export function buildQueryString(params?: CloudUsageQuery): string {
  if (!params) return ''
  const parts: string[] = []
  if (params.dateFilter) parts.push(`date_filter=${params.dateFilter}`)
  if (params.page) parts.push(`page=${params.page}`)
  if (params.pageSize) parts.push(`page_size=${params.pageSize}`)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

export interface CloudUsageApi {
  getUsage(params?: CloudUsageQuery): Promise<CloudUsagePage<CloudUsageLog>>
  getCombinedUsage(params?: CloudUsageQuery): Promise<CloudUsagePage<CloudCombinedUsageLog>>
  getToolUsage(params?: CloudUsageQuery): Promise<CloudUsagePage<CloudToolUsageLog>>
  getSpeechUsage(params?: CloudUsageQuery): Promise<CloudUsagePage<CloudSpeechUsageLog>>
  getAgentUsage(params?: CloudUsageQuery): Promise<CloudUsagePage<CloudAgentUsageLog>>
  getAgentTokenActivity(params?: CloudAgentTokenActivityQuery): Promise<CloudAgentTokenActivity>
  getAgentTurnUsage(turnId: string): Promise<CloudAgentTurnUsage>
}

export function createUsageApi(client: CloudApiClient): CloudUsageApi {
  return {
    /** 获取模型调用日志 */
    getUsage: async (params) => {
      const response = await client.get<CloudUsagePage<CloudUsageLog>>(`/me/usage${buildQueryString(params)}`)
      return response.data
    },
    /** 获取合并后的模型调用与 Agent API 调用日志 */
    getCombinedUsage: async (params) => {
      const response = await client.get<CloudUsagePage<CloudCombinedUsageLog>>(`/me/combined-usage${buildQueryString(params)}`)
      return response.data
    },
    /** 获取工具调用日志 */
    getToolUsage: async (params) => {
      const response = await client.get<CloudUsagePage<CloudToolUsageLog>>(`/me/tool-usage${buildQueryString(params)}`)
      return response.data
    },
    /** 获取语音用量日志 */
    getSpeechUsage: async (params) => {
      const response = await client.get<CloudUsagePage<CloudSpeechUsageLog>>(`/me/speech-usage${buildQueryString(params)}`)
      return response.data
    },
    /** 获取 Agent API 调用日志 */
    getAgentUsage: async (params) => {
      const response = await client.get<CloudUsagePage<CloudAgentUsageLog>>(`/me/agent-usage${buildQueryString(params)}`)
      return response.data
    },
    /** 获取 Proma Agent 的每日 Token 活跃度（不含 Chat、工具和语音）。 */
    getAgentTokenActivity: async (params) => {
      const search = new URLSearchParams()
      if (params?.startDate) search.set('start_date', params.startDate)
      if (params?.endDate) search.set('end_date', params.endDate)
      const query = search.size > 0 ? `?${search.toString()}` : ''
      const response = await client.get<CloudAgentTokenActivity>(`/me/agent-token-activity${query}`)
      return response.data
    },
    /** 获取一个官方 Agent 轮次的权威积分账本聚合。 */
    getAgentTurnUsage: async (turnId) => {
      const response = await client.get<CloudAgentTurnUsage>(`/me/agent-turn-usage/${encodeURIComponent(turnId)}`)
      return response.data
    },
  }
}
