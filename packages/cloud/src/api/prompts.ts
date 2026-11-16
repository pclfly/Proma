/**
 * Cloud 提示词 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/prompts.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type { CloudPromptsResponse } from '../types/prompt.ts'

export interface CloudPromptsApi {
  list(): Promise<CloudPromptsResponse>
}

export function createPromptsApi(client: CloudApiClient): CloudPromptsApi {
  return {
    /** 获取云端提示词列表 */
    list: async () => {
      const response = await client.get<CloudPromptsResponse>('/prompts')
      return response.data
    },
  }
}
