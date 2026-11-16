/**
 * Cloud 通知服务（纯逻辑部分）
 *
 * 从官方 0.22.0 `src/main/lib/cloud-notification-service.ts` 提取：
 * - 平台映射（darwin → macos，其余 → windows）
 * - 未登录降级
 * - pending 载荷归一化（复用 @proma/cloud 的单一实现）
 *
 * 真实 API 客户端与 IPC 注册 deferred。
 */

import type { CloudNotification } from '@proma/cloud'
import { normalizePendingNotifications } from '@proma/cloud'
import type { CloudServiceResult } from './cloud-service-types'
import { CLOUD_NOT_LOGGED_IN_ERROR, getSafeCloudApiErrorMessage } from './cloud-service-types'

export type CloudNotificationPlatform = 'macos' | 'windows'

/** 官方 getNotificationPlatform 等价实现 */
export function getCloudNotificationPlatform(platform: string = process.platform): CloudNotificationPlatform {
  return platform === 'darwin' ? 'macos' : 'windows'
}

/**
 * 通知服务运行时依赖。
 *
 * 由后续批次注入真实 Cloud 客户端与登录态；纯逻辑层只依赖该接口，
 * 便于测试未登录/失败降级。
 */
export interface CloudNotificationRuntime {
  hasAuthToken(): boolean
  listPending(platform: CloudNotificationPlatform): Promise<unknown>
  acknowledge(notificationId: string, platform: CloudNotificationPlatform): Promise<void>
}

/** 获取 pending 通知；未登录直接返回降级结果，不发起请求。 */
export async function getPendingCloudNotifications(
  runtime: CloudNotificationRuntime,
): Promise<CloudServiceResult<CloudNotification[]>> {
  if (!runtime.hasAuthToken()) return { success: false, error: CLOUD_NOT_LOGGED_IN_ERROR }
  try {
    const payload = await runtime.listPending(getCloudNotificationPlatform())
    return { success: true, data: normalizePendingNotifications(payload) }
  } catch (error) {
    return {
      success: false,
      error: getSafeCloudApiErrorMessage(error, '获取通知失败，请稍后重试'),
    }
  }
}

/** 确认通知；通知 ID 为空或未登录时直接返回降级结果。 */
export async function acknowledgeCloudNotification(
  runtime: CloudNotificationRuntime,
  notificationId: string,
): Promise<CloudServiceResult<void>> {
  if (!notificationId) return { success: false, error: '通知 ID 无效' }
  if (!runtime.hasAuthToken()) return { success: false, error: CLOUD_NOT_LOGGED_IN_ERROR }
  try {
    await runtime.acknowledge(notificationId, getCloudNotificationPlatform())
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getSafeCloudApiErrorMessage(error, '确认通知失败，请稍后重试'),
    }
  }
}
