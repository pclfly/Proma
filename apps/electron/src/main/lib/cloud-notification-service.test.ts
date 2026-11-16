import { describe, expect, test } from 'bun:test'
import { createApiError } from '@proma/cloud'
import type { CloudNotificationRuntime } from './cloud-notification-service'
import {
  acknowledgeCloudNotification,
  getCloudNotificationPlatform,
  getPendingCloudNotifications,
} from './cloud-notification-service'

function runtime(overrides: Partial<CloudNotificationRuntime> = {}): CloudNotificationRuntime & {
  calls: Array<{ method: string; platform?: string; notificationId?: string }>
} {
  const calls: Array<{ method: string; platform?: string; notificationId?: string }> = []
  return {
    calls,
    hasAuthToken: () => true,
    listPending: async (platform) => {
      calls.push({ method: 'list', platform })
      return { notifications: [] }
    },
    acknowledge: async (notificationId, platform) => {
      calls.push({ method: 'ack', notificationId, platform })
    },
    ...overrides,
  }
}

describe('Cloud 通知平台映射', () => {
  test('Given macOS/Linux/Windows When 映射 Then 仅 darwin 为 macos', () => {
    expect(getCloudNotificationPlatform('darwin')).toBe('macos')
    expect(getCloudNotificationPlatform('win32')).toBe('windows')
    expect(getCloudNotificationPlatform('linux')).toBe('windows')
  })
})

describe('Pending 通知降级与归一化', () => {
  test('Given 未登录 When 获取通知 Then 返回未登录且不发起请求', async () => {
    const fake = runtime({ hasAuthToken: () => false })
    const result = await getPendingCloudNotifications(fake)
    expect(result).toEqual({ success: false, error: '未登录' })
    expect(fake.calls).toHaveLength(0)
  })

  test('Given 已登录 When 获取通知 Then 过滤非法项并透传平台', async () => {
    const fake = runtime({
      listPending: async (platform) => ({
        notifications: [
          {
            id: 'n1',
            title: '公告',
            bodyMarkdown: '内容',
            platform,
            publishedAt: '2026-01-01T00:00:00Z',
          },
          { id: 'bad' },
        ],
      }),
    })
    const result = await getPendingCloudNotifications(fake)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.map((item) => item.id)).toEqual(['n1'])
      expect(result.data[0]?.platform).toBe(getCloudNotificationPlatform())
    }
  })

  test('Given 接口抛结构化错误 When 获取通知 Then 返回安全文案', async () => {
    const fake = runtime({
      listPending: async () => { throw createApiError(503) },
    })
    const result = await getPendingCloudNotifications(fake)
    expect(result).toEqual({ success: false, error: 'Proma Cloud 暂时不可用，请稍后重试' })
  })

  test('Given 接口抛普通错误 When 获取通知 Then 使用兜底文案', async () => {
    const fake = runtime({
      listPending: async () => { throw new Error('socket hang up') },
    })
    const result = await getPendingCloudNotifications(fake)
    expect(result).toEqual({ success: false, error: '获取通知失败，请稍后重试' })
  })
})

describe('确认通知降级', () => {
  test('Given 空通知 ID When 确认 Then 返回 ID 无效', async () => {
    const fake = runtime()
    expect(await acknowledgeCloudNotification(fake, '')).toEqual({ success: false, error: '通知 ID 无效' })
    expect(fake.calls).toHaveLength(0)
  })

  test('Given 未登录 When 确认 Then 返回未登录', async () => {
    const fake = runtime({ hasAuthToken: () => false })
    expect(await acknowledgeCloudNotification(fake, 'n1')).toEqual({ success: false, error: '未登录' })
    expect(fake.calls).toHaveLength(0)
  })

  test('Given 已登录 When 确认 Then 调用运行时并返回成功', async () => {
    const fake = runtime()
    const result = await acknowledgeCloudNotification(fake, 'n1')
    expect(result.success).toBe(true)
    expect(fake.calls).toEqual([{
      method: 'ack',
      notificationId: 'n1',
      platform: getCloudNotificationPlatform(),
    }])
  })

  test('Given 确认失败 When 调用 Then 返回兜底文案', async () => {
    const fake = runtime({
      acknowledge: async () => { throw new Error('boom') },
    })
    expect(await acknowledgeCloudNotification(fake, 'n1'))
      .toEqual({ success: false, error: '确认通知失败，请稍后重试' })
  })
})
