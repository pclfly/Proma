import { describe, expect, test } from 'bun:test'
import {
  getCloudCatalogDefaultAgentModel,
  isCloudModelCatalogSnapshot,
  normalizeCloudModelProviderGroups,
} from './model'

describe('官方模型目录快照', () => {
  test('Given 合法 agent 目录 When 校验 Then 通过', () => {
    expect(isCloudModelCatalogSnapshot({
      agent: [
        { id: 'proma-agent', display_name: 'Proma Agent' },
        { id: 'proma-fast' },
      ],
      chat: [{ models: [{ id: 'chat-1', name: 'Chat 1' }] }],
      defaultAgentModelId: 'proma-agent',
    })).toBe(true)
  })

  test('Given 空 agent 目录 When 校验 Then 仍通过（官方允许空数组）', () => {
    expect(isCloudModelCatalogSnapshot({ agent: [] })).toBe(true)
  })

  test('Given 非法载荷 When 校验 Then 拒绝', () => {
    expect(isCloudModelCatalogSnapshot(null)).toBe(false)
    expect(isCloudModelCatalogSnapshot([])).toBe(false)
    expect(isCloudModelCatalogSnapshot({})).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: 'nope' })).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: [{ id: '' }] })).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: [{ id: '   ' }] })).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: [{ id: 'x', display_name: 1 }] })).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: [{ id: 'x' }], chat: {} })).toBe(false)
    expect(isCloudModelCatalogSnapshot({ agent: [null] })).toBe(false)
  })

  test('Given defaultAgentModelId 存在 When 解析 Then 返回该 id', () => {
    expect(getCloudCatalogDefaultAgentModel({
      agent: [{ id: 'a' }, { id: 'b' }],
      defaultAgentModelId: 'b',
    })).toBe('b')
  })

  test('Given defaultAgentModelId 不在目录或缺失 When 解析 Then 返回 undefined', () => {
    expect(getCloudCatalogDefaultAgentModel({
      agent: [{ id: 'a' }],
      defaultAgentModelId: 'zzz',
    })).toBeUndefined()
    expect(getCloudCatalogDefaultAgentModel({ agent: [{ id: 'a' }] })).toBeUndefined()
    expect(getCloudCatalogDefaultAgentModel({ agent: [] })).toBeUndefined()
  })
})

describe('云端模型列表归一化', () => {
  test('Given 裸数组 When 归一化 Then 保留含 models 数组的分组', () => {
    const groups = normalizeCloudModelProviderGroups([
      { provider: 'proma', models: [{ id: 'a' }] },
      { provider: 'broken', models: 'nope' },
      null,
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.provider).toBe('proma')
  })

  test('Given providers 包裹 When 归一化 Then 解包', () => {
    const groups = normalizeCloudModelProviderGroups({
      providers: [{ provider: 'zhipu', models: [{ id: 'glm' }] }],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.models[0]?.id).toBe('glm')
  })

  test('Given models 包裹 When 归一化 Then 解包', () => {
    const groups = normalizeCloudModelProviderGroups({
      models: [{ provider: 'openai', models: [] }],
    })
    expect(groups).toHaveLength(1)
  })

  test('Given 空或非法载荷 When 归一化 Then 返回空数组', () => {
    expect(normalizeCloudModelProviderGroups(undefined)).toEqual([])
    expect(normalizeCloudModelProviderGroups(null)).toEqual([])
    expect(normalizeCloudModelProviderGroups({})).toEqual([])
    expect(normalizeCloudModelProviderGroups('nope')).toEqual([])
  })
})
