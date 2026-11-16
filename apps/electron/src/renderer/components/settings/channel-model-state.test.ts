import { describe, expect, test } from 'bun:test'
import { enableChannelModel, mergeFetchedChannelModels, formatBuiltInContextWindow } from './channel-model-state'
import { inferKnownContextWindow } from '@proma/shared'

describe('模型上下文展示与启用', () => {
  test('Given 内置上下文 When 启用模型 Then 填入上下文输入值', () => {
    expect(enableChannelModel({ id: 'test', name: 'Test', enabled: false, builtInContextWindow: 128000 })).toMatchObject({ enabled: true, contextWindow: 128000 })
  })
  test('Given 手动上下文 When 再次启用 Then 保留手动值', () => {
    expect(enableChannelModel({ id: 'test', name: 'Test', enabled: false, builtInContextWindow: 128000, contextWindow: 64000 }).contextWindow).toBe(64000)
  })
  test('Given 未知模型 When 启用与显示 Then 不猜测窗口', () => {
    expect(inferKnownContextWindow('unknown-model')).toBeUndefined()
    expect(enableChannelModel({ id: 'unknown', name: 'Unknown', enabled: false }).contextWindow).toBeUndefined()
    expect(formatBuiltInContextWindow(undefined)).toBe('上下文未知')
  })
  test('Given 内置模型与参考数值 When 显示 Then 使用紧凑标签', () => {
    expect(inferKnownContextWindow('gpt-6-astra')).toBe(272000)
    expect(formatBuiltInContextWindow(1000000)).toBe('1M')
    expect(formatBuiltInContextWindow(128000)).toBe('128K')
    expect(formatBuiltInContextWindow(131072)).toBe('131,072')
  })
  test('Given 已配置订阅模型 When 重新获取 Then 不覆盖上下文并自动填充新模型', () => {
    const old = [{ id: 'old', name: 'Old', enabled: true, contextWindow: 12345 }]
    const fetched = [
      { id: 'old', name: 'Old', enabled: true, builtInContextWindow: 128000 },
      { id: 'new', name: 'New', enabled: true, builtInContextWindow: 372000 },
    ]
    const result = mergeFetchedChannelModels(old, fetched, true)
    expect(result[0]?.contextWindow).toBe(12345)
    expect(result[1]?.contextWindow).toBe(372000)
  })
  test('Given 已启用项明确清空上下文 When 刷新 Then 保留自动模式', () => {
    for (const autoEnable of [false, true]) {
      const result = mergeFetchedChannelModels([{ id: 'old', name: 'Old', enabled: true }], [{ id: 'old', name: 'Old', enabled: true, builtInContextWindow: 128000 }], autoEnable)
      expect(result[0]?.contextWindow).toBeUndefined()
    }
  })
  test('Given 普通拉取和手动模型 When 合并 Then 保留手动项与启用状态而新项不自动启用', () => {
    const old = [{ id: 'manual', name: 'Manual', enabled: true, source: 'manual' as const }, { id: 'old', name: 'Old', enabled: true }]
    const result = mergeFetchedChannelModels(old, [
      { id: 'old', name: 'Old', enabled: true, builtInContextWindow: 128000 },
      { id: 'new', name: 'New', enabled: true, builtInContextWindow: 372000 },
    ], false)
    expect(result[0]?.id).toBe('manual')
    expect(result[1]).toMatchObject({ enabled: true })
    expect(result[1]?.contextWindow).toBeUndefined()
    expect(result[2]).toMatchObject({ enabled: false })
    expect(result[2]?.contextWindow).toBeUndefined()
  })
})
