/**
 * Cloud 订阅 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/subscription.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type {
  CloudAlipayPaymentOrder,
  CloudSubscriptionCurrent,
  CloudSubscriptionHistoryPage,
  CloudSubscriptionHistoryQuery,
  CloudSubscriptionOrder,
  CloudSubscriptionTier,
  CloudWechatPaymentOrder,
} from '../types/subscription.ts'

export interface CloudSubscriptionApi {
  getTiers(): Promise<CloudSubscriptionTier[]>
  getCurrent(): Promise<CloudSubscriptionCurrent>
  createWechatPayment(tierId: string): Promise<CloudWechatPaymentOrder>
  createAlipayPayment(tierId: string): Promise<CloudAlipayPaymentOrder>
  getOrderStatus(orderNo: string): Promise<CloudSubscriptionOrder>
  getHistory(params?: CloudSubscriptionHistoryQuery): Promise<CloudSubscriptionHistoryPage>
}

export function createSubscriptionApi(client: CloudApiClient): CloudSubscriptionApi {
  return {
    /** 获取订阅档位列表 */
    getTiers: async () => {
      const response = await client.get<CloudSubscriptionTier[]>('/subscription/tiers')
      return response.data
    },
    /** 获取当前活跃订阅汇总 */
    getCurrent: async () => {
      const response = await client.get<CloudSubscriptionCurrent>('/subscription/current')
      return response.data
    },
    /** 创建订阅微信支付订单 */
    createWechatPayment: async (tierId) => {
      const response = await client.post<CloudWechatPaymentOrder>('/subscription/wechat/create', {
        tier: tierId,
      })
      return response.data
    },
    /** 创建订阅支付宝当面付二维码订单 */
    createAlipayPayment: async (tierId) => {
      const response = await client.post<CloudAlipayPaymentOrder>('/subscription/alipay/create', {
        tier: tierId,
      })
      return response.data
    },
    /** 查询订阅订单状态 */
    getOrderStatus: async (orderNo) => {
      const response = await client.get<CloudSubscriptionOrder>(`/subscription/orders/${orderNo}`)
      return response.data
    },
    /** 获取订阅历史 */
    getHistory: async (params = {}) => {
      const searchParams = new URLSearchParams()
      if (params.page !== undefined) searchParams.set('page', String(params.page))
      if (params.page_size !== undefined) searchParams.set('page_size', String(params.page_size))
      const query = searchParams.size > 0 ? `?${searchParams.toString()}` : ''
      const response = await client.get<CloudSubscriptionHistoryPage>(`/subscription/history${query}`)
      return response.data
    },
  }
}
