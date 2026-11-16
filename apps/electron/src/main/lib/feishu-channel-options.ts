/**
 * 飞书 / Lark 客户端与 Channel 统一选项。
 *
 * 官方 0.22.0：测试连接与 Channel 启动共用同一套 appId/secret/domain/日志级别，
 * 避免两处 domain 或 logger 配置漂移。Channel 额外关闭 SDK per-chat 串行，
 * 由 Proma 自己的并发模型控制。
 */

import type { FeishuBotConfig } from '@proma/shared'
import type * as LarkSdk from '@larksuiteoapi/node-sdk'
import { normalizeFeishuDomain } from './feishu-domain'

export interface FeishuClientConfig {
  appId: string
  domain?: FeishuBotConfig['domain']
}

export function buildFeishuClientOptions(
  config: FeishuClientConfig,
  appSecret: string,
  lark: typeof LarkSdk,
) {
  return {
    appId: config.appId,
    appSecret,
    domain: normalizeFeishuDomain(config.domain) === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
  }
}

export function buildFeishuChannelOptions(
  config: FeishuClientConfig,
  appSecret: string,
  lark: typeof LarkSdk,
) {
  return {
    ...buildFeishuClientOptions(config, appSecret, lark),
    policy: {
      dmMode: 'open' as const,
      requireMention: false,
      respondToMentionAll: false,
    },
    safety: { chatQueue: { enabled: false } },
    includeRawEvent: true,
  }
}
