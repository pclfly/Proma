import { describe, expect, test } from 'bun:test'
import type { CloudChatModelGroup } from '@proma/cloud'
import {
  OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE,
  applyOfficialModelEnabledStates,
  flattenOfficialChatModels,
  getCatalogDefaultAgentModel,
  isOfficialModelCatalogSnapshot,
  mapOfficialAgentModels,
  preserveOfficialModelEnabledStates,
  resolveLegacyOfficialModels,
} from './cloud-channel-service'

describe('官方模型目录快照校验', () => {
  test('Given 合法快照 When 校验 Then 通过并可取默认模型', () => {
    const snapshot = {
      agent: [{ id: 'a', display_name: 'A' }, { id: 'b' }],
      defaultAgentModelId: 'b',
    }
    expect(isOfficialModelCatalogSnapshot(snapshot)).toBe(true)
    if (isOfficialModelCatalogSnapshot(snapshot)) {
      expect(getCatalogDefaultAgentModel(snapshot)).toBe('b')
    }
  })

  test('Given 空 agent When 校验 Then 通过但无默认模型', () => {
    const snapshot = { agent: [] }
    expect(isOfficialModelCatalogSnapshot(snapshot)).toBe(true)
    if (isOfficialModelCatalogSnapshot(snapshot)) {
      expect(getCatalogDefaultAgentModel(snapshot)).toBeUndefined()
    }
  })

  test('Given 非法 agent 项 When 校验 Then 拒绝', () => {
    expect(isOfficialModelCatalogSnapshot({ agent: [{ id: '' }] })).toBe(false)
    expect(isOfficialModelCatalogSnapshot({ agent: [{ display_name: 'x' }] })).toBe(false)
    expect(isOfficialModelCatalogSnapshot({ chat: [] })).toBe(false)
  })
})

describe('chat 模型拍平与排序', () => {
  test('Given 带 chatSortOrder When 拍平 Then 按序号排序，缺失序号排后', () => {
    const groups: CloudChatModelGroup[] = [
      { models: [
        { id: 'no-order-1', name: 'N1' },
        { id: 'order-20', name: 'O20', chatSortOrder: 20 },
      ] },
      { models: [
        { id: 'order-10', name: 'O10', chatSortOrder: 10 },
        { id: 'no-order-2', name: 'N2' },
      ] },
    ]
    expect(flattenOfficialChatModels(groups).map((model) => model.id)).toEqual([
      'order-10',
      'order-20',
      'no-order-1',
      'no-order-2',
    ])
  })

  test('Given 相同 chatSortOrder When 拍平 Then 按 id 字典序', () => {
    const groups: CloudChatModelGroup[] = [
      { models: [
        { id: 'b', name: 'B', chatSortOrder: 1 },
        { id: 'a', name: 'A', chatSortOrder: 1 },
      ] },
    ]
    expect(flattenOfficialChatModels(groups).map((model) => model.id)).toEqual(['a', 'b'])
  })

  test('Given 都无排序号 When 拍平 Then 保持原分组顺序', () => {
    const groups: CloudChatModelGroup[] = [
      { models: [{ id: 'z', name: 'Z' }, { id: 'a', name: 'A' }] },
      { models: [{ id: 'm', name: 'M' }] },
    ]
    expect(flattenOfficialChatModels(groups).map((model) => model.id)).toEqual(['z', 'a', 'm'])
  })

  test('Given metadata.modelListHint When 拍平 Then trim 后写入，空白丢弃', () => {
    const models = flattenOfficialChatModels([{
      models: [
        { id: 'a', name: 'A', metadata: { modelListHint: '  提示  ' } },
        { id: 'b', name: 'B', metadata: { modelListHint: '   ' } },
        { id: 'c', name: 'C' },
      ],
    }])
    expect(models[0]?.modelListHint).toBe('提示')
    expect(models[1]).not.toHaveProperty('modelListHint')
    expect(models[2]).not.toHaveProperty('modelListHint')
    expect(models.every((model) => model.enabled)).toBe(true)
  })
})

describe('agent 模型映射', () => {
  test('Given 完整 agent 项 When 映射 Then 保留可选能力字段', () => {
    const models = mapOfficialAgentModels([{
      id: 'agent-1',
      display_name: 'Agent 1',
      apiProtocol: 'openai-completions',
      contextWindow: 256_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
      modelListHint: '  推荐  ',
    }])
    expect(models[0]).toEqual({
      id: 'agent-1',
      name: 'Agent 1',
      enabled: true,
      apiProtocol: 'openai-completions',
      contextWindow: 256_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
      modelListHint: '推荐',
    })
  })

  test('Given 缺少 display_name/可选字段 When 映射 Then 回退 id 且不写空字段', () => {
    const models = mapOfficialAgentModels([{ id: 'agent-2' }])
    expect(models[0]).toEqual({ id: 'agent-2', name: 'agent-2', enabled: true })
    expect(models[0]).not.toHaveProperty('contextWindow')
    expect(models[0]).not.toHaveProperty('modelListHint')
  })
})

describe('官方渠道启用状态', () => {
  test('Given 请求与现有 id 一致 When 应用 Then 只更新 enabled', () => {
    const existing = [
      { id: 'a', name: 'A', enabled: true, extra: 1 },
      { id: 'b', name: 'B', enabled: false },
    ]
    const result = applyOfficialModelEnabledStates(existing, [
      { id: 'a', enabled: false },
      { id: 'b', enabled: true },
    ])
    expect(result).toEqual([
      { id: 'a', name: 'A', enabled: false, extra: 1 },
      { id: 'b', name: 'B', enabled: true },
    ])
  })

  test('Given 请求数量不一致/重复 id/未知 id When 应用 Then 抛锁定错误', () => {
    const existing = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }]
    expect(() => applyOfficialModelEnabledStates(existing, [{ id: 'a', enabled: false }]))
      .toThrow(OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE)
    expect(() => applyOfficialModelEnabledStates(existing, [
      { id: 'a', enabled: false },
      { id: 'a', enabled: true },
    ])).toThrow(OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE)
    expect(() => applyOfficialModelEnabledStates(existing, [
      { id: 'a', enabled: false },
      { id: 'c', enabled: true },
    ])).toThrow(OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE)
  })

  test('Given 目录刷新 When 保留状态 Then 已存在模型沿用用户选择，新模型用目录默认', () => {
    const catalog = [
      { id: 'a', name: 'A', enabled: true },
      { id: 'b', name: 'B', enabled: false },
      { id: 'c', name: 'C', enabled: true },
    ]
    const result = preserveOfficialModelEnabledStates(catalog, [
      { id: 'a', enabled: false },
      { id: 'b', enabled: true },
    ])
    expect(result.map((model) => [model.id, model.enabled])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ])
  })

  test('Given 旧配置迁移 When incoming 存在 Then 保留 existing 的启用状态', () => {
    const existing = [{ id: 'a', enabled: false }]
    expect(resolveLegacyOfficialModels(undefined, existing)).toEqual(existing)
    expect(resolveLegacyOfficialModels([{ id: 'a', enabled: true }], existing))
      .toEqual([{ id: 'a', enabled: false }])
  })
})
