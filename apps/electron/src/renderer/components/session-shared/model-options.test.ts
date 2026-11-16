import { describe, expect, test } from 'bun:test'
import type { Channel, ModelOption } from '@proma/shared'
import { buildModelOptions, getDisplayModelInfo, groupByChannel } from './model-options'

const channels: Channel[] = [
  { id: 'a', name: '渠道A', provider: 'openai', baseUrl: 'https://invalid.example', apiKey: '', enabled: true, createdAt: 0, updatedAt: 0, models: [{ id: 'one', name: '模型一', enabled: true }, { id: 'off', name: '停用', enabled: false }] },
  { id: 'b', name: '渠道B', provider: 'google', baseUrl: 'https://invalid.example', apiKey: '', enabled: true, createdAt: 0, updatedAt: 0, models: [{ id: 'two', name: '模型二', enabled: true }] },
  { id: 'disabled', name: '停用渠道', provider: 'openai', baseUrl: '', apiKey: '', enabled: false, createdAt: 0, updatedAt: 0, models: [{ id: 'hidden', name: '不展示', enabled: true }] },
]

const first: ModelOption = { channelId: 'a', channelName: '渠道A', modelId: 'one', modelName: '模型一', provider: 'openai' }
const second: ModelOption = { channelId: 'b', channelName: '渠道B', modelId: 'two', modelName: '模型二', provider: 'google' }

describe('共享模型选择器的受控语义', () => {
  test('Given 未提供渠道过滤 When 建立选项 Then 包含所有启用渠道和模型', () => {
    expect(buildModelOptions(channels)).toEqual([first, second])
    expect([...groupByChannel(buildModelOptions(channels)).keys()]).toEqual(['a', 'b'])
  })
  test('Given 显式空渠道集合 When 建立选项 Then 为空而不是退回全列表', () => {
    expect(buildModelOptions(channels, undefined, [])).toEqual([])
  })
  test('Given 单渠道/集合/供应商限制 When 过滤 Then 保留交集而不扩大候选', () => {
    expect(buildModelOptions(channels, 'a')).toEqual([first])
    expect(buildModelOptions(channels, 'a', ['b'])).toEqual([])
    expect(buildModelOptions(channels, undefined, ['a', 'b'], ['google'])).toEqual([first])
  })
  test('Given 显式空选择 When 曾有显示缓存 Then 不复活上次选中模型', () => {
    expect(getDisplayModelInfo(null, null, first)).toBeNull()
    expect(getDisplayModelInfo(null, first, first)).toBeNull()
  })
  test('Given 同一模型的渠道暂未加载 When 存在对应缓存 Then 可维持名称', () => {
    expect(getDisplayModelInfo(first, null, first)).toBe(first)
    expect(getDisplayModelInfo(first, first, second)).toBe(first)
  })
  test('Given 切到另一选择 When 旧缓存不匹配 Then 不错误显示旧模型', () => {
    expect(getDisplayModelInfo(second, null, first)).toBeNull()
    expect(getDisplayModelInfo({ channelId: 'b', modelId: 'one' }, null, first)).toBeNull()
  })
})
