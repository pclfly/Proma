/**
 * Cloud 通知 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/notifications.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type { CloudNotification } from '../types/notification.ts'
import { normalizePendingNotifications } from '../types/notification.ts'

export interface CloudNotificationsApi {
  listPending(platform: string): Promise<CloudNotification[]>
  acknowledge(notificationId: string, platform: string): Promise<void>
}

export function createNotificationsApi(client: CloudApiClient): CloudNotificationsApi {
  return {
    /** 获取当前设备尚未确认的通知。 */
    listPending: async (platform) => {
      const response = await client.get<unknown>(`/notifications/pending?platform=${platform}`)
      return normalizePendingNotifications(response.data)
    },
    /** 确认通知，确认后服务端不再将其作为 pending 返回。 */
    acknowledge: async (notificationId, platform) => {
      await client.post<unknown>(
        `/notifications/${encodeURIComponent(notificationId)}/acknowledge?platform=${platform}`,
      )
    },
  }
}
