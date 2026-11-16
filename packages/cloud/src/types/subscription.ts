/**
 * Cloud 订阅与支付类型
 *
 * 覆盖官方 0.22.0 `/subscription/*` 六个端点。支付渠道只保留协议结构，
 * 本轮不接入真实下单（主进程服务 deferred）。
 */

export interface CloudSubscriptionTier {
  id: string
  name?: string
  price?: number
  currency?: string
  period?: string
  [key: string]: unknown
}

export interface CloudSubscriptionCurrent {
  tier?: string | null
  status?: string
  expiresAt?: string | null
  [key: string]: unknown
}

export interface CloudSubscriptionOrder {
  orderNo?: string
  status?: string
  [key: string]: unknown
}

/** 微信支付二维码订单 */
export interface CloudWechatPaymentOrder extends CloudSubscriptionOrder {
  codeUrl?: string
  [key: string]: unknown
}

/** 支付宝当面付二维码订单 */
export interface CloudAlipayPaymentOrder extends CloudSubscriptionOrder {
  qrCode?: string
  [key: string]: unknown
}

export interface CloudSubscriptionHistoryQuery {
  page?: number
  page_size?: number
}

export interface CloudSubscriptionHistoryPage {
  items: CloudSubscriptionOrder[]
  total?: number
  [key: string]: unknown
}
