/**
 * Cloud 通知类型与运行时校验
 *
 * 官方 0.22.0 通过 `isCloudNotification` 过滤 pending 列表：
 * 必要字段为 id / title / bodyMarkdown / platform / publishedAt。
 */

export interface CloudNotification {
  id: string
  title: string
  bodyMarkdown: string
  platform: string
  publishedAt: string
  [key: string]: unknown
}

/** 服务端可能返回数组，也可能返回 { notifications: [...] } */
export interface CloudNotificationsEnvelope {
  notifications?: unknown
  [key: string]: unknown
}

export function isCloudNotification(value: unknown): value is CloudNotification {
  if (typeof value !== 'object' || value === null) return false
  const notification = value as Record<string, unknown>
  return (
    typeof notification.id === 'string'
    && typeof notification.title === 'string'
    && typeof notification.bodyMarkdown === 'string'
    && typeof notification.platform === 'string'
    && typeof notification.publishedAt === 'string'
  )
}

/**
 * 归一化 pending 通知载荷。
 *
 * 非数组（或包裹结构中 notifications 非数组）时返回空数组，
 * 与官方行为一致：坏数据不阻塞其余通知。
 */
export function normalizePendingNotifications(payload: unknown): CloudNotification[] {
  const wrappedItems = typeof payload === 'object' && payload !== null
    ? (payload as CloudNotificationsEnvelope).notifications
    : undefined
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(wrappedItems)
      ? wrappedItems
      : []
  return items.filter(isCloudNotification)
}
