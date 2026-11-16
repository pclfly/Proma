import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSyncWithRetry } from './fs-retry'
import { createStableDingTalkBotId } from './dingtalk-bot-identity'

let root = ''
mock.module('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => { throw new Error('仅更新项目不应触碰凭据加解密') },
} }))
mock.module('./config-paths', () => ({
  getFeishuConfigPath: () => join(root, 'feishu.json'),
  getDingTalkConfigPath: () => join(root, 'dingtalk.json'),
  getDingTalkBotBindingsPath: (id: string) => join(root, `${id}-bindings.json`),
  getWeChatConfigPath: () => join(root, 'wechat.json'),
}))
const { updateFeishuDefaultWorkspace } = await import('./feishu-config')
const { updateDingTalkDefaultWorkspace } = await import('./dingtalk-config')
const { updateWeChatDefaultWorkspace } = await import('./wechat-config')
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'proma-bridge-default-')) })
afterEach(() => { rmSyncWithRetry(root, { recursive: true, force: true }) })

for (const platform of ['feishu', 'dingtalk'] as const) describe(`${platform}默认项目的精确更新`, () => {
  test('Given 密文/渠道/未知字段和另一Bot When 切换并回滚未设置 Then 只有目标默认字段变化', () => {
    const id = platform === 'dingtalk' ? createStableDingTalkBotId('fixture-client') : 'fixture-bot'
    const otherId = platform === 'dingtalk' ? createStableDingTalkBotId('other-client') : 'other-bot'
    if (!id || !otherId) throw new Error('合成Bot标识生成失败')
    const bot = { id, name: 'fixture', enabled: true, appId: 'fixture-app', appSecret: 'opaque-secret',
      clientId: 'fixture-client', clientSecret: 'opaque-client-secret', domain: 'lark',
      defaultChannelId: 'custom-channel', defaultModelId: 'custom-model', customField: { keep: true } }
    const before = { version: 2, bots: [bot, { ...bot, id: otherId, clientId: 'other-client', defaultWorkspaceId: 'OTHER' }], untouched: 'value' }
    const path = join(root, `${platform}.json`)
    writeFileSync(path, JSON.stringify(before))
    const update = platform === 'feishu' ? updateFeishuDefaultWorkspace : updateDingTalkDefaultWorkspace
    update(id, 'B')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...before, bots: [{ ...bot, defaultWorkspaceId: 'B' }, before.bots[1]] })
    update(id, undefined)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before)
  })
  test('Given 原配置损坏 When 仅更新项目 Then 报错且不以空配置覆盖原文', () => {
    const path = join(root, `${platform}.json`)
    writeFileSync(path, '{broken-keep-me')
    const update = platform === 'feishu' ? updateFeishuDefaultWorkspace : updateDingTalkDefaultWorkspace
    expect(() => update('missing', 'B')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken-keep-me')
  })
})

describe('微信默认项目的精确更新', () => {
  test('Given 密文凭据和扩展字段 When 切换并回滚 Then 保留其余配置', () => {
    const before = { enabled: true, credentials: { botToken: 'opaque', botId: 'fixture', baseUrl: 'https://invalid.invalid' }, extra: { keep: true } }
    const path = join(root, 'wechat.json')
    writeFileSync(path, JSON.stringify(before))
    updateWeChatDefaultWorkspace('B')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...before, defaultWorkspaceId: 'B' })
    updateWeChatDefaultWorkspace(undefined)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before)
  })
  for (const raw of ['{broken', 'null', '[]']) test(`Given 原文${raw}无效 When 更新 Then 不覆盖损坏配置`, () => {
    const path = join(root, 'wechat.json')
    writeFileSync(path, raw)
    expect(() => updateWeChatDefaultWorkspace('B')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})
