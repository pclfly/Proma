import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelPlanQuotaResult, ProviderType } from '@proma/shared'
import {
  createPlanQuotaStore,
  PLAN_QUOTA_CHANNELS_REFRESH_DELAY_MS,
  PLAN_QUOTA_USAGE_REFRESH_DELAY_MS,
} from './plan-quota-store'
import type { PlanQuotaChannel, PlanQuotaStoreOptions } from './plan-quota-store'

const NOW = 1_700_000_000_000

interface ScheduledTask {
  delayMs: number
  run: () => void
  cancelled: boolean
}

function makeChannel(id: string, provider: ProviderType, updatedAt = 1): PlanQuotaChannel {
  return {
    id,
    name: `${provider} 渠道`,
    provider,
    baseUrl: 'https://example.test',
    enabled: true,
    updatedAt,
  }
}

function quota(
  provider: ProviderType,
  windows: ChannelPlanQuotaResult['windows'],
  extra: Partial<ChannelPlanQuotaResult> = {},
): ChannelPlanQuotaResult {
  return {
    supported: true,
    provider,
    windows,
    updatedAt: NOW,
    ...extra,
  }
}

interface HarnessOptions {
  channels: PlanQuotaChannel[]
  query?: (channelId: string) => Promise<ChannelPlanQuotaResult>
  cachePath?: string
  supportsQuota?: PlanQuotaStoreOptions['supportsQuota']
  onChange?: PlanQuotaStoreOptions['onChange']
}

function createHarness(initial: HarnessOptions) {
  let now = NOW
  let channels = initial.channels
  let query = initial.query ?? (async () => {
    throw new Error('未配置查询结果')
  })
  const calls: string[] = []
  const scheduled: ScheduledTask[] = []

  const store = createPlanQuotaStore({
    listChannels: () => channels,
    queryQuota: (channelId) => {
      calls.push(channelId)
      return query(channelId)
    },
    cachePath: initial.cachePath,
    supportsQuota: initial.supportsQuota,
    onChange: initial.onChange,
    now: () => now,
    schedule: (callback, delayMs) => {
      const task: ScheduledTask = { delayMs, run: callback, cancelled: false }
      scheduled.push(task)
      return task
    },
    cancelSchedule: (handle) => {
      const task = handle as ScheduledTask
      task.cancelled = true
    },
  })

  return {
    store,
    calls,
    scheduled,
    setChannels(next: PlanQuotaChannel[]): void { channels = next },
    setQuery(next: (channelId: string) => Promise<ChannelPlanQuotaResult>): void { query = next },
    advance(ms: number): void { now += ms },
  }
}

describe('多来源 Plan 额度汇总', () => {
  test('Given 两个启用额度渠道 When 刷新 Then 汇总双方来源与窗口', async () => {
    const harness = createHarness({
      channels: [
        makeChannel('kimi', 'kimi-coding'),
        makeChannel('zhipu', 'zhipu-coding'),
        { ...makeChannel('disabled', 'deepseek'), enabled: false },
      ],
      query: async (channelId) => channelId === 'kimi'
        ? quota('kimi-coding', [
          { type: '5h', label: '每 5 小时', remainingPercent: 72, usedPercent: 28 },
          { type: 'weekly', label: '每周额度', remainingPercent: 54, usedPercent: 46 },
        ], { planName: 'Kimi Pro', tier: 'Pro' })
        : quota('zhipu-coding', [
          { type: 'weekly', label: '每周额度', remainingPercent: 30, usedPercent: 70 },
        ], {
          planName: 'GLM Coding Plan',
          credits: { remaining: 4_000, total: 10_000, unit: '积分', remainingLabel: '4000 积分' },
        }),
    })

    const snapshot = await harness.store.refresh('initial')

    expect(harness.calls).toEqual(['kimi', 'zhipu'])
    expect(snapshot.sources).toHaveLength(2)
    expect(snapshot.sources[0]).toMatchObject({
      channelId: 'kimi',
      provider: 'kimi-coding',
      label: 'kimi-coding 渠道',
      planName: 'Kimi Pro',
      tier: 'Pro',
    })
    expect(snapshot.sources[0]?.windows.map((window) => window.type)).toEqual(['5h', 'weekly'])
    expect(snapshot.sources[1]).toMatchObject({
      channelId: 'zhipu',
      credits: { remaining: 4_000, total: 10_000 },
    })
    expect(snapshot.refreshedAt).toBe(NOW)
    expect(snapshot.stale).toBe(false)
  })

  test('Given 供应商只返回每周窗口 When 汇总 Then 不伪造 5H 窗口', async () => {
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => quota('kimi-coding', [
        { type: 'weekly', label: '每周额度', remainingPercent: 40, usedPercent: 60 },
      ]),
    })

    const snapshot = await harness.store.refresh('initial')

    expect(snapshot.sources[0]?.windows).toHaveLength(1)
    expect(snapshot.sources[0]?.windows[0]?.type).toBe('weekly')
  })

  test('Given 首次成功但再次查询失败 When 刷新 Then 保留旧窗口并标记 stale', async () => {
    let shouldFail = false
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => {
        if (shouldFail) throw new Error('网络错误')
        return quota('kimi-coding', [
          { type: '5h', label: '每 5 小时', remainingPercent: 80, usedPercent: 20 },
        ], { planName: 'Kimi Pro' })
      },
    })

    await harness.store.refresh('initial')
    shouldFail = true
    harness.advance(20_000)
    const snapshot = await harness.store.refresh('manual')

    expect(snapshot.sources[0]).toMatchObject({
      planName: 'Kimi Pro',
      error: '网络错误',
      stale: true,
      windows: [{ type: '5h', remainingPercent: 80 }],
    })
    expect(snapshot.refreshedAt).toBe(NOW)
    expect(snapshot.stale).toBe(true)
  })

  test('Given 供应商用 unsupported 返回鉴权失败 When 刷新 Then 仍保留旧窗口', async () => {
    let shouldFail = false
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => shouldFail
        ? {
          supported: false,
          provider: 'kimi-coding',
          windows: [],
          updatedAt: NOW + 20_000,
          message: 'Kimi 额度查询失败: HTTP 401',
        }
        : quota('kimi-coding', [
          { type: 'weekly', label: '每周额度', remainingPercent: 60, usedPercent: 40 },
        ]),
    })

    await harness.store.refresh('initial')
    shouldFail = true
    harness.advance(20_000)
    const snapshot = await harness.store.refresh('manual')

    expect(snapshot.sources[0]).toMatchObject({
      windows: [{ type: 'weekly', remainingPercent: 60 }],
      error: 'Kimi 额度查询失败: HTTP 401',
      stale: true,
    })
    expect(snapshot.stale).toBe(true)
  })

  test('Given 渠道换号 When 新凭据查询失败 Then 不沿用旧账号额度', async () => {
    let shouldFail = false
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding', 1)],
      query: async () => {
        if (shouldFail) throw new Error('新账号鉴权失败')
        return quota('kimi-coding', [
          { type: '5h', label: '每 5 小时', remainingPercent: 80, usedPercent: 20 },
        ], { planName: 'Kimi Pro', tier: 'Pro' })
      },
    })

    await harness.store.refresh('initial')
    harness.setChannels([makeChannel('kimi', 'kimi-coding', 2)])
    shouldFail = true
    const snapshot = await harness.store.refresh('channels-changed')

    expect(snapshot.sources[0]).toMatchObject({
      channelId: 'kimi',
      windows: [],
      error: '新账号鉴权失败',
      stale: true,
    })
    expect(snapshot.sources[0]?.planName).toBeUndefined()
    expect(snapshot.sources[0]?.tier).toBeUndefined()
  })

  test('Given 渠道在请求途中换号 When 旧请求完成 Then 自动补刷新账号', async () => {
    let resolveFirst: ((result: ChannelPlanQuotaResult) => void) | undefined
    let callCount = 0
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding', 1)],
      query: () => {
        callCount += 1
        if (callCount === 1) {
          return new Promise<ChannelPlanQuotaResult>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(quota('kimi-coding', [
          { type: 'weekly', label: '每周额度', remainingPercent: 90, usedPercent: 10 },
        ], { planName: 'Kimi Max' }))
      },
    })

    const first = harness.store.refresh('initial')
    harness.setChannels([makeChannel('kimi', 'kimi-coding', 2)])
    const channelChanged = harness.store.refresh('channels-changed')
    resolveFirst?.(quota('kimi-coding', [
      { type: 'weekly', label: '每周额度', remainingPercent: 10, usedPercent: 90 },
    ], { planName: 'Kimi Pro' }))

    await Promise.all([first, channelChanged])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.calls).toHaveLength(2)
    expect(harness.store.getSnapshot().sources[0]?.planName).toBe('Kimi Max')
  })

  test('Given 并发刷新 When 前一次仍在进行 Then 合并为同一次查询', async () => {
    let resolveQuery: ((result: ChannelPlanQuotaResult) => void) | undefined
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: () => new Promise<ChannelPlanQuotaResult>((resolve) => {
        resolveQuery = resolve
      }),
    })

    const first = harness.store.refresh('initial')
    const second = harness.store.refresh('manual')
    expect(harness.calls).toEqual(['kimi'])

    resolveQuery?.(quota('kimi-coding', [
      { type: 'weekly', label: '每周额度', remainingPercent: 50, usedPercent: 50 },
    ]))
    const [left, right] = await Promise.all([first, second])

    expect(left).toBe(right)
    expect(harness.calls).toHaveLength(1)
  })

  test('Given 创建与刷新 When 无使用事件 Then 不安排任何后台任务', async () => {
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => quota('kimi-coding', []),
    })

    expect(harness.scheduled).toHaveLength(0)
    await harness.store.refresh('initial')
    expect(harness.scheduled).toHaveLength(0)

    harness.store.noteUsage()
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0]?.delayMs).toBe(PLAN_QUOTA_USAGE_REFRESH_DELAY_MS)

    harness.advance(PLAN_QUOTA_USAGE_REFRESH_DELAY_MS)
    const scheduledBefore = harness.scheduled.length
    harness.scheduled[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.calls).toHaveLength(2)
    expect(harness.scheduled).toHaveLength(scheduledBefore)

    // 再推进 10 分钟也不能出现新的自动任务或查询，证明没有后台轮询。
    harness.advance(10 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.calls).toHaveLength(2)
    expect(harness.scheduled).toHaveLength(scheduledBefore)
  })

  test('Given 自动刷新仍在节流窗口 When 再次进入 Then 复用快照而不重复请求', async () => {
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => quota('kimi-coding', [
        { type: 'weekly', label: '每周额度', remainingPercent: 50, usedPercent: 50 },
      ]),
    })

    const first = await harness.store.refresh('initial')
    harness.advance(1_000)
    const second = await harness.store.refresh('initial')

    expect(second).toBe(first)
    expect(harness.calls).toHaveLength(1)
  })

  test('Given 渠道连续保存 When 通知变化 Then 只安排一次短延迟刷新', () => {
    const harness = createHarness({
      channels: [makeChannel('kimi', 'kimi-coding')],
      query: async () => quota('kimi-coding', []),
    })

    harness.store.noteChannelsChanged()
    harness.store.noteChannelsChanged()

    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0]?.delayMs).toBe(PLAN_QUOTA_CHANNELS_REFRESH_DELAY_MS)
  })

  test('Given 缓存文件 When 刷新 Then 只落盘展示数据，不含凭据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-plan-quota-'))
    const cachePath = join(dir, 'plan-quota-cache.json')
    try {
      const harness = createHarness({
        channels: [makeChannel('kimi', 'kimi-coding', 1)],
        cachePath,
        query: async () => quota('kimi-coding', [
          { type: '5h', label: '每 5 小时', remainingPercent: 66, usedPercent: 34 },
        ], { planName: 'Kimi Pro' }),
      })
      await harness.store.refresh('initial')

      const raw = readFileSync(cachePath, 'utf-8')
      expect(raw).not.toContain('apiKey')
      expect(raw).not.toContain('Bearer')
      expect(JSON.parse(raw)).toMatchObject({
        version: 1,
        channelVersions: { kimi: 1 },
        sources: [{ channelId: 'kimi', planName: 'Kimi Pro' }],
      })

      // 换号后读取旧缓存必须丢弃，不能把上一个账号的额度展示给新账号。
      const rotated = createHarness({
        channels: [makeChannel('kimi', 'kimi-coding', 2)],
        cachePath,
        query: async () => quota('kimi-coding', []),
      })
      expect(rotated.store.getSnapshot().sources).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 渠道被禁用 When 读取快照 Then 立即隐藏该来源', async () => {
    const channel = makeChannel('kimi', 'kimi-coding')
    const harness = createHarness({
      channels: [channel],
      query: async () => quota('kimi-coding', [
        { type: 'weekly', label: '每周额度', remainingPercent: 50, usedPercent: 50 },
      ]),
    })
    await harness.store.refresh('initial')
    harness.setChannels([{ ...channel, enabled: false }])

    expect(harness.store.getSnapshot().sources).toEqual([])
  })
})
