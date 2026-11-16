/**
 * Cloud 模型 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/models.ts` 对齐。
 * 返回结构由后端定义，调用方用 `normalizeCloudModelProviderGroups` 做容错解析。
 */

import type { CloudApiClient } from '../types/api.ts'

export interface CloudModelsApi {
  getModels(): Promise<unknown>
}

export function createModelsApi(client: CloudApiClient): CloudModelsApi {
  return {
    /** 获取服务端模型列表（按供应商分组） */
    getModels: async () => {
      const response = await client.get<unknown>('/models')
      return response.data
    },
  }
}
