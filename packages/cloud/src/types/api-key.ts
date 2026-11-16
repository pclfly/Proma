/**
 * Cloud API Key 类型
 *
 * `proma-agent-key-service` 依赖的字段：id / name / status / key。
 */

export type CloudApiKeyStatus = 'ACTIVE' | 'DISABLED' | string

export interface CloudApiKey {
  id: string
  name: string
  status: CloudApiKeyStatus
  /** 明文 key（仅创建/获取 system key 时返回） */
  key?: string
  description?: string
  quotaLimit?: number
  [key: string]: unknown
}

/** system API key 响应（pk_xxx） */
export interface CloudSystemApiKey {
  key: string
  [key: string]: unknown
}

export interface CloudCreateApiKeyParams {
  name: string
  description?: string
  quotaLimit?: number
  [key: string]: unknown
}

export interface CloudUpdateApiKeyParams {
  name?: string
  description?: string
  quotaLimit?: number
  status?: CloudApiKeyStatus
  [key: string]: unknown
}
