/**
 * DeepSeek 渠道迁移。
 *
 * 官方 0.21.92 的 v11 迁移会关闭“已启用但未配置 API Key”的 DeepSeek 渠道，
 * 避免渠道列表里出现必然失败的可用项。这里保持同样的纯函数，便于测试与复用。
 */

import type { Channel } from '@proma/shared'

/** 已启用但没有可用 API Key 的 DeepSeek 渠道 → 关闭；其他渠道原样返回。 */
export function disableUnconfiguredDeepSeekChannel(channel: Channel, apiKey: string): Channel {
  if (channel.provider !== 'deepseek' || !channel.enabled || apiKey.trim()) return channel
  return { ...channel, enabled: false }
}
