/**
 * Cloud 账单 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/billing.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type { CloudBalanceCheck, CloudBillingInfo } from '../types/billing.ts'

export interface CloudBillingApi {
  getBilling(): Promise<CloudBillingInfo>
  checkBalance(): Promise<CloudBalanceCheck>
}

export function createBillingApi(client: CloudApiClient): CloudBillingApi {
  return {
    /** 获取账单信息 */
    getBilling: async () => {
      const response = await client.get<CloudBillingInfo>('/user/billing')
      return response.data
    },
    /** 检查余额是否充足 */
    checkBalance: async () => {
      const response = await client.get<CloudBalanceCheck>('/user/check-balance')
      return response.data
    },
  }
}
