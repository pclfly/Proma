import { describe, expect, test } from 'bun:test'
import type { Channel, ChannelModel, ChannelPlanQuotaResult } from '@proma/shared'
import {
  buildChannelCards,
  formatChannelModelCount,
  hasModelListChanges,
  isQuotaFailure,
  sortChannelsForCards,
  summarizeChannelError,
} from './channel-cards'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: overrides.id ?? 'channel-1',
    name: overrides.name ?? '渠道',
    provider: overrides.provider ?? 'deepseek',
    baseUrl: overrides.baseUrl ?? 'https://api.deepseek.com/anthropic',
    apiKey: overrides.apiKey ?? '',
    models: overrides.models ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  }
}

function makeModel(overrides: Partial<ChannelModel> = {}): ChannelModel {
  return { id: overrides.id ?? 'model-1', name: overrides.name ?? 'Model', enabled: overrides.enabled ?? true, ...overrides }
}

function makeQuota(overrides: Partial<ChannelPlanQuotaResult> = {}): ChannelPlanQuotaResult {
  return {
    supported: true,
    provider: 'deepseek',
    windows: [{ type: '5h', label: '5 小时', remainingPercent: 80, usedPercent: 20 }],
    updatedAt: 1,
    ...overrides,
  }
}

describe('渠道卡片排序', () => {
  test('Given 启用与停用渠道混排 When 排序 Then 已启用渠道优先且组内按名称排序', () => {
    const channels = [
      makeChannel({ id: 'beta', name: 'Beta', enabled: false }),
      makeChannel({ id: 'zulu-1', name: 'Zulu', enabled: true }),
      makeChannel({ id: 'alpha-off', name: 'Alpha', enabled: false }),
      makeChannel({ id: 'alpha-on', name: 'Alpha', enabled: true }),
      makeChannel({ id: 'zulu-2', name: 'Zulu', enabled: true }),
    ]

    expect(sortChannelsForCards(channels).map((channel) => channel.id)).toEqual([
      'alpha-on',
      'zulu-1',
      'zulu-2',
      'alpha-off',
      'beta',
    ])
  })

  test('Given 同名渠道 When 排序 Then 保持传入顺序且不修改原数组', () => {
    const first = makeChannel({ id: 'first', name: 'Same', enabled: true })
    const second = makeChannel({ id: 'second', name: 'Same', enabled: true })
    const input = [first, second]

    expect(sortChannelsForCards(input).map((channel) => channel.id)).toEqual(['first', 'second'])
    expect(input.map((channel) => channel.id)).toEqual(['first', 'second'])
  })

  test('Given 空渠道列表 When 排序与构建卡片 Then 返回空数组', () => {
    expect(sortChannelsForCards([])).toEqual([])
    expect(buildChannelCards([])).toEqual([])
  })
})

describe('渠道卡片摘要', () => {
  test('Given 多渠道 When 构建卡片 Then 已启用优先且附带 provider 标签', () => {
    const cards = buildChannelCards([
      makeChannel({ id: 'off', name: 'B', enabled: false }),
      makeChannel({ id: 'on', name: 'A', enabled: true }),
    ])

    expect(cards.map((card) => card.channel.id)).toEqual(['on', 'off'])
    expect(cards[0]?.providerLabel).toBe('DeepSeek')
  })

  test('Given 模型启用与停用 When 统计 Then 展示启用数与总数', () => {
    expect(formatChannelModelCount(makeChannel())).toBe('暂无模型')
    expect(formatChannelModelCount(makeChannel({
      models: [makeModel({ id: 'a', enabled: true }), makeModel({ id: 'b', enabled: false })],
    }))).toBe('1 个模型已启用 / 共 2 个')
    expect(formatChannelModelCount(makeChannel({
      models: [makeModel({ id: 'a', enabled: false }), makeModel({ id: 'b', enabled: false }), makeModel({ id: 'c', enabled: false })],
    }))).toBe('0 个模型已启用 / 共 3 个')
  })

  test('Given 缓存额度 When 构建卡片 Then 生成短摘要；无缓存则不显示', () => {
    const channel = makeChannel({ id: 'quota', models: [makeModel()] })
    const withQuota = buildChannelCards([channel], { quotaOf: () => makeQuota() })[0]
    const withoutQuota = buildChannelCards([channel], { quotaOf: () => null })[0]

    expect(withQuota?.quotaSummary).toBe('5H 80%')
    expect(withoutQuota?.quotaSummary).toBeNull()
    expect(withoutQuota?.modelCountLabel).toBe('1 个模型已启用 / 共 1 个')
  })

  test('Given 最近错误 When 构建卡片 Then 保留截断摘要与完整提示', () => {
    const message = `网络错误：${'连接超时'.repeat(30)}`
    const card = buildChannelCards([makeChannel({ id: 'broken' })], { errorOf: () => message })[0]

    expect(card?.errorSummary?.length).toBe(72)
    expect(card?.errorSummary?.endsWith('…')).toBe(true)
    expect(card?.errorTitle).toBe(message)
    expect(card?.errorSummary).not.toBe(card?.errorTitle)
  })
})

describe('错误文案截断', () => {
  test('Given 短文案 When 摘要 Then 原样返回', () => {
    expect(summarizeChannelError('连接失败')).toBe('连接失败')
  })

  test('Given 换行与连续空白 When 摘要 Then 折叠为单行', () => {
    expect(summarizeChannelError('  第一行\n\n第二行\t 内容  ')).toBe('第一行 第二行 内容')
  })

  test('Given 超长文案 When 摘要 Then 截断并追加省略号', () => {
    const summary = summarizeChannelError('错误'.repeat(100), 20)

    expect(summary?.length).toBe(20)
    expect(summary?.startsWith('错误错误')).toBe(true)
    expect(summary?.endsWith('…')).toBe(true)
  })

  test('Given 空文案 When 摘要 Then 返回 null', () => {
    expect(summarizeChannelError(undefined)).toBeNull()
    expect(summarizeChannelError(null)).toBeNull()
    expect(summarizeChannelError('   \n  ')).toBeNull()
  })
})

describe('模型清单变化判定', () => {
  test('Given 内容一致仅顺序不同 When 比较 Then 视为未变化', () => {
    const previous = [makeModel({ id: 'a' }), makeModel({ id: 'b', enabled: false })]
    const next = [makeModel({ id: 'b', enabled: false }), makeModel({ id: 'a' })]

    expect(hasModelListChanges(previous, next)).toBe(false)
  })

  test('Given 启用状态、上下文或数量变化 When 比较 Then 视为已变化', () => {
    const base = [makeModel({ id: 'a', enabled: true })]

    expect(hasModelListChanges(base, [makeModel({ id: 'a', enabled: false })])).toBe(true)
    expect(hasModelListChanges(base, [{ ...makeModel({ id: 'a' }), contextWindow: 128000 }])).toBe(true)
    expect(hasModelListChanges(base, [...base, makeModel({ id: 'b' })])).toBe(true)
  })
})

describe('额度错误归类', () => {
  test('Given 查询失败 When 判定 Then 视为错误；无窗口数据不算错误', () => {
    expect(isQuotaFailure(makeQuota({ supported: false, windows: [], message: 'Kimi 额度查询失败: HTTP 500' }))).toBe(true)
    expect(isQuotaFailure(makeQuota({ supported: false, windows: [], message: 'Kimi 未返回订阅额度数据' }))).toBe(false)
    expect(isQuotaFailure(makeQuota())).toBe(false)
    expect(isQuotaFailure(null)).toBe(false)
  })
})
