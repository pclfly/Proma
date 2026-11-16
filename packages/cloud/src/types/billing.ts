/**
 * Cloud 账单类型
 */

export interface CloudBillingInfo {
  balance?: number
  currency?: string
  /** 套餐名称/档位（后端扩展字段） */
  plan?: string
  [key: string]: unknown
}

export interface CloudBalanceCheck {
  sufficient: boolean
  balance?: number
  [key: string]: unknown
}
