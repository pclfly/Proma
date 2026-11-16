import { describe, expect, test } from 'bun:test'
import { buildFeishuChannelOptions, buildFeishuClientOptions } from './feishu-channel-options'

const lark = {
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
  LoggerLevel: { warn: 'warn-level' },
} as unknown as typeof import('@larksuiteoapi/node-sdk')

describe('飞书 Channel 选项', () => {
  test('Given 飞书配置 When 构建客户端 Then 使用飞书域名与 warn 日志', () => {
    const options = buildFeishuClientOptions({ appId: 'app', domain: 'feishu' }, 'secret', lark)
    expect(options.appId).toBe('app')
    expect(options.appSecret).toBe('secret')
    expect(String(options.domain)).toBe('feishu-domain')
    expect(String(options.loggerLevel)).toBe('warn-level')
  })

  test('Given Lark 配置 When 构建 Channel Then 使用 Lark 域名并关闭 SDK chatQueue', () => {
    const options = buildFeishuChannelOptions({ appId: 'app', domain: 'lark' }, 'secret', lark)
    expect(String(options.domain)).toBe('lark-domain')
    expect(options.policy).toEqual({
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    })
    expect(options.safety).toEqual({ chatQueue: { enabled: false } })
    expect(options.includeRawEvent).toBe(true)
  })

  test('Given 未设置域名 When 构建 Then 默认飞书', () => {
    expect(String(buildFeishuClientOptions({ appId: 'app' }, 'secret', lark).domain))
      .toBe('feishu-domain')
  })
})
