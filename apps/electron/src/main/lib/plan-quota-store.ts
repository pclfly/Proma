/**
 * 多来源 Plan 额度汇总存储。
 *
 * 只汇总当前启用且支持额度查询的渠道；刷新完全按需发生：
 * 首次读取、用户展开、渠道变化或一轮对话结束后（节流后）才会请求供应商。
 * 这里没有 setInterval / 后台轮询，缓存文件只保存展示数据，不保存任何凭据。
 */

import type {
  ChannelPlanQuotaResult,
  PlanQuotaSnapshot,
  PlanQuotaSource,
  ProviderType,
} from '@proma/shared'
import { readPlanQuotaCache, writePlanQuotaCache } from './plan-quota-cache'

/** 自动触发（首次进入、对话结束）的最小刷新间隔。 */
export const PLAN_QUOTA_AUTO_THROTTLE_MS = 60_000
/** 用户主动展开时的最小刷新间隔。 */
export const PLAN_QUOTA_MANUAL_THROTTLE_MS = 10_000
/** 渠道增删改后的刷新延迟，用于合并短时间内的多次保存。 */
export const PLAN_QUOTA_CHANNELS_REFRESH_DELAY_MS = 1_500
/** 一轮对话结束后的刷新延迟，避免每个 token 事件都触发查询。 */
export const PLAN_QUOTA_USAGE_REFRESH_DELAY_MS = 20_000
/** 超过该时间未成功刷新时，快照标记为 stale。 */
export const PLAN_QUOTA_STALE_AFTER_MS = 5 * 60_000

const SUPPORTED_PLAN_QUOTA_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'deepseek',
  'kimi-coding',
  'minimax',
  'zhipu',
  'zhipu-coding',
  'zhipu-coding-team',
  'openai-codex',
  'github-copilot',
])

export interface PlanQuotaChannel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  enabled: boolean
  updatedAt: number
}

export type PlanQuotaRefreshTrigger = 'initial' | 'manual' | 'channels-changed' | 'usage'

export interface PlanQuotaStoreOptions {
  listChannels: () => PlanQuotaChannel[]
  queryQuota: (channelId: string) => Promise<ChannelPlanQuotaResult>
  /** 额度缓存文件路径；缺省时不持久化。 */
  cachePath?: string
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancelSchedule?: (handle: unknown) => void
  /** 刷新完成后的通知（主进程用于广播给渲染层）。 */
  onChange?: (snapshot: PlanQuotaSnapshot) => void
  supportsQuota?: (channel: PlanQuotaChannel) => boolean
}

export interface PlanQuotaStore {
  getSnapshot: () => PlanQuotaSnapshot
  refresh: (trigger?: PlanQuotaRefreshTrigger) => Promise<PlanQuotaSnapshot>
  /** 一轮对话结束后调用：只安排一次延迟刷新。 */
  noteUsage: () => void
  /** 渠道增删改后调用：安排一次短延迟刷新。 */
  noteChannelsChanged: () => void
  dispose: () => void
}

/** 默认的额度渠道判定；与渲染层旧的单渠道徽标保持同一组 provider。 */
export function supportsPlanQuotaChannel(channel: PlanQuotaChannel): boolean {
  if (SUPPORTED_PLAN_QUOTA_PROVIDERS.has(channel.provider)) return true
  const baseUrl = channel.baseUrl.toLowerCase()
  return baseUrl.includes('api.kimi.com/coding') || baseUrl.includes('api.kimi.ai/coding')
}

const EMPTY_SNAPSHOT: PlanQuotaSnapshot = { sources: [], refreshedAt: 0, stale: false }

function throttleFor(trigger: PlanQuotaRefreshTrigger): number {
  if (trigger === 'manual') return PLAN_QUOTA_MANUAL_THROTTLE_MS
  if (trigger === 'channels-changed') return PLAN_QUOTA_CHANNELS_REFRESH_DELAY_MS
  if (trigger === 'usage') return PLAN_QUOTA_USAGE_REFRESH_DELAY_MS
  return PLAN_QUOTA_AUTO_THROTTLE_MS
}

/**
 * 创建额度汇总存储。
 *
 * 依赖全部通过参数注入，测试无需 Electron、配置文件或真实网络。
 */
export function createPlanQuotaStore(options: PlanQuotaStoreOptions): PlanQuotaStore {
  const clock = options.now ?? Date.now
  const supportsQuota = options.supportsQuota ?? supportsPlanQuotaChannel
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelSchedule = options.cancelSchedule ?? ((handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

  const isEligible = (channel: PlanQuotaChannel): boolean => channel.enabled && supportsQuota(channel)

  let channelVersions: Record<string, number> = {}
  let snapshot: PlanQuotaSnapshot = EMPTY_SNAPSHOT
  let lastAttemptAt = 0
  let inFlight: Promise<PlanQuotaSnapshot> | null = null
  let followUpTrigger: PlanQuotaRefreshTrigger | null = null
  let scheduled: { handle: unknown; trigger: PlanQuotaRefreshTrigger } | null = null
  let disposed = false

  function readCache(): void {
    if (!options.cachePath) return
    const loaded = readPlanQuotaCache(
      options.cachePath,
      options.listChannels(),
      isEligible,
      clock(),
      PLAN_QUOTA_STALE_AFTER_MS,
    )
    if (!loaded) return
    channelVersions = loaded.channelVersions
    snapshot = loaded.snapshot
  }

  function persist(): void {
    if (!options.cachePath) return
    writePlanQuotaCache(options.cachePath, snapshot, channelVersions)
  }

  function publish(next: PlanQuotaSnapshot): PlanQuotaSnapshot {
    snapshot = next
    persist()
    try {
      options.onChange?.(next)
    } catch (error) {
      console.warn('[额度汇总] 通知监听方失败:', error)
    }
    return next
  }

  function toSource(channel: PlanQuotaChannel, result: ChannelPlanQuotaResult): PlanQuotaSource {
    return {
      channelId: channel.id,
      provider: result.provider,
      label: channel.name,
      ...(result.planName ? { planName: result.planName } : {}),
      ...(result.tier ? { tier: result.tier } : {}),
      windows: result.windows.map((window) => ({ ...window })),
      ...(result.credits ? { credits: { ...result.credits } } : {}),
      updatedAt: result.updatedAt,
      ...(result.supported ? {} : { error: result.message ?? '额度查询失败' }),
    }
  }

  function previousSource(channel: PlanQuotaChannel): PlanQuotaSource | undefined {
    if (channelVersions[channel.id] !== channel.updatedAt) return undefined
    return snapshot.sources.find((source) => source.channelId === channel.id)
  }

  function isStillCurrent(expected: PlanQuotaChannel): boolean {
    const latest = options.listChannels().find((channel) => channel.id === expected.id)
    return !!latest
      && latest.updatedAt === expected.updatedAt
      && isEligible(latest)
  }

  function finalize(
    startedAt: number,
    results: Array<{ channel: PlanQuotaChannel; result?: ChannelPlanQuotaResult; error?: string }>,
  ): PlanQuotaSnapshot {
    const nextVersions: Record<string, number> = {}
    const sources: PlanQuotaSource[] = []
    let hadSuccess = false
    let hadRetainedFailure = false

    for (const { channel, result, error } of results) {
      // 请求期间渠道被删除或换号时丢弃结果，避免旧账号额度串到新账号。
      if (!isStillCurrent(channel)) continue
      nextVersions[channel.id] = channel.updatedAt

      if (result) {
        const succeeded = result.supported && result.windows.length > 0
        if (succeeded) {
          hadSuccess = true
          sources.push(toSource(channel, result))
          continue
        }

        // 供应商以 supported=false / 空窗口返回时同样是失败：有旧数据就保留并标记 stale，
        // 不能因为一次 HTTP 或鉴权错误把用户看到的额度直接归零。
        const previous = previousSource(channel)
        if (previous) {
          hadRetainedFailure = true
          sources.push({ ...previous, error: result.message ?? '额度查询失败', stale: true })
        } else {
          const source = toSource(channel, result)
          source.error = result.message ?? '未返回额度数据'
          source.stale = true
          sources.push(source)
        }
        continue
      }

      const previous = previousSource(channel)
      if (previous) {
        hadRetainedFailure = true
        sources.push({ ...previous, error: error ?? '额度查询失败', stale: true })
      } else {
        sources.push({
          channelId: channel.id,
          provider: channel.provider,
          label: channel.name,
          windows: [],
          updatedAt: startedAt,
          error: error ?? '额度查询失败',
          stale: true,
        })
      }
    }

    const refreshedAt = hadSuccess ? startedAt : (snapshot.refreshedAt || startedAt)
    const stale = hadRetainedFailure
      || sources.some((source) => source.stale)
      || (refreshedAt > 0 && startedAt - refreshedAt > PLAN_QUOTA_STALE_AFTER_MS)

    channelVersions = nextVersions
    return publish({ sources, refreshedAt, stale })
  }

  async function runRefresh(trigger: PlanQuotaRefreshTrigger, startedAt: number): Promise<PlanQuotaSnapshot> {
    const channels = options.listChannels().filter(isEligible)
    if (channels.length === 0) {
      channelVersions = {}
      return publish({ sources: [], refreshedAt: startedAt, stale: false })
    }

    const results = await Promise.all(channels.map(async (channel) => {
      try {
        return { channel, result: await options.queryQuota(channel.id) }
      } catch (error) {
        return {
          channel,
          error: error instanceof Error ? error.message : '额度查询失败',
        }
      }
    }))
    return finalize(startedAt, results)
  }

  function preferTrigger(
    current: PlanQuotaRefreshTrigger | null,
    next: PlanQuotaRefreshTrigger,
  ): PlanQuotaRefreshTrigger {
    if (current === 'channels-changed' || next === 'channels-changed') return 'channels-changed'
    if (current === 'manual' || next === 'manual') return 'manual'
    return next
  }

  function refresh(trigger: PlanQuotaRefreshTrigger = 'initial'): Promise<PlanQuotaSnapshot> {
    if (inFlight) {
      // 渠道在请求途中换号时，当前结果会被 finalize 丢弃；这里登记一次补刷，
      // 避免 1.5s 的渠道变化刷新被 in-flight 合并吞掉。
      followUpTrigger = preferTrigger(followUpTrigger, trigger)
      return inFlight
    }
    const startedAt = clock()
    const shouldThrottle = trigger !== 'channels-changed'
      && snapshot.refreshedAt > 0
      && startedAt - lastAttemptAt < throttleFor(trigger)
    if (shouldThrottle) return Promise.resolve(snapshot)

    lastAttemptAt = startedAt
    inFlight = runRefresh(trigger, startedAt).finally(() => {
      inFlight = null
      const next = followUpTrigger
      followUpTrigger = null
      if (next && !disposed) void refresh(next)
    })
    return inFlight
  }

  function scheduleRefresh(delayMs: number, trigger: PlanQuotaRefreshTrigger): void {
    if (disposed) return
    if (scheduled) {
      // 渠道变化需要尽快反映，可以把更晚的使用后刷新提前。
      if (trigger !== 'channels-changed' || scheduled.trigger === 'channels-changed') return
      cancelSchedule(scheduled.handle)
      scheduled = null
    }
    const handle = schedule(() => {
      scheduled = null
      void refresh(trigger)
    }, delayMs)
    scheduled = { handle, trigger }
  }

  function getSnapshot(): PlanQuotaSnapshot {
    if (snapshot.refreshedAt > 0
      && !snapshot.stale
      && clock() - snapshot.refreshedAt > PLAN_QUOTA_STALE_AFTER_MS) {
      snapshot = { ...snapshot, stale: true }
    }
    if (snapshot.sources.length === 0) return snapshot
    const channels = options.listChannels()
    const matched = snapshot.sources.filter((source) => {
      const channel = channels.find((item) => item.id === source.channelId)
      return !!channel
        && isEligible(channel)
        && channel.updatedAt === channelVersions[source.channelId]
    })
    if (matched.length !== snapshot.sources.length) {
      snapshot = { ...snapshot, sources: matched }
    }
    return snapshot
  }

  readCache()

  return {
    getSnapshot,
    refresh,
    noteUsage: () => scheduleRefresh(PLAN_QUOTA_USAGE_REFRESH_DELAY_MS, 'usage'),
    noteChannelsChanged: () => scheduleRefresh(PLAN_QUOTA_CHANNELS_REFRESH_DELAY_MS, 'channels-changed'),
    dispose: () => {
      disposed = true
      if (scheduled) {
        cancelSchedule(scheduled.handle)
        scheduled = null
      }
    },
  }
}
