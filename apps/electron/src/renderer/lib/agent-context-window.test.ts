import { describe, expect, test } from 'bun:test'
import { resolveKnownRunContextWindow, resolveRunContextWindow } from './agent-context-window'
import type { Channel } from '@proma/shared'

function channelWith(models: Array<{ id: string; contextWindow?: number }>): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'custom',
    enabled: true,
    models: models.map((model) => ({ ...model, name: model.id, enabled: true })),
  } as unknown as Channel
}

describe('切换模型时的上下文窗口解析', () => {
  test('Given 渠道里为模型配置了窗口 When 解析 Then 采用配置值', () => {
    const channel = channelWith([{ id: 'my-gateway-model', contextWindow: 1_000_000 }])
    expect(resolveKnownRunContextWindow('my-gateway-model', channel)).toBe(1_000_000)
  })

  test('Given 模型名可识别但没有显式配置 When 解析 Then 采用已知推断', () => {
    expect(resolveKnownRunContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
  })

  test('Given 模型完全未知 When 解析 Then 不返回 200K 猜测值，交由调用方保留旧值', () => {
    expect(resolveKnownRunContextWindow('some-unlisted-gateway-model')).toBeUndefined()
  })

  test('Given 发送新的一轮 When 解析 Then 允许回退到历史值和 200K 兜底', () => {
    expect(resolveRunContextWindow('some-unlisted-gateway-model', 640_000)).toBe(200_000)
    expect(resolveRunContextWindow(undefined, 640_000)).toBe(640_000)
  })
})
