/**
 * Cloud API Key API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/api-keys.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type {
  CloudApiKey,
  CloudCreateApiKeyParams,
  CloudSystemApiKey,
  CloudUpdateApiKeyParams,
} from '../types/api-key.ts'

export interface CloudApiKeysApi {
  getSystemApiKey(): Promise<CloudSystemApiKey>
  list(): Promise<CloudApiKey[]>
  create(params: CloudCreateApiKeyParams): Promise<CloudApiKey>
  update(keyId: string, params: CloudUpdateApiKeyParams): Promise<CloudApiKey>
  delete(keyId: string): Promise<void>
}

export function createApiKeysApi(client: CloudApiClient): CloudApiKeysApi {
  return {
    /** 获取 system API key（pk_xxx 格式） */
    getSystemApiKey: async () => {
      const response = await client.get<CloudSystemApiKey>('/api-keys/system')
      return response.data
    },
    /** 获取用户的所有自定义 API Keys */
    list: async () => {
      const response = await client.get<CloudApiKey[]>('/api-keys')
      return response.data
    },
    /** 创建新的 API Key */
    create: async (params) => {
      const response = await client.post<CloudApiKey>('/api-keys', params)
      return response.data
    },
    /** 更新 API Key */
    update: async (keyId, params) => {
      const response = await client.patch<CloudApiKey>(`/api-keys/${keyId}`, params)
      return response.data
    },
    /** 删除 API Key */
    delete: async (keyId) => {
      await client.del<unknown>(`/api-keys/${keyId}`)
    },
  }
}
