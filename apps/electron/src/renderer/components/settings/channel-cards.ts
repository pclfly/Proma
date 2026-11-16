/**
 * 渠道卡片排序与摘要
 *
 * 只做纯数据投影：不发起请求、不读写 storage，便于单测覆盖排序与文案边界。
 */

import { PROVIDER_LABELS } from '@proma/shared'
import type { Channel, ChannelModel, ChannelPlanQuotaResult } from '@proma/shared'
import { getPlanQuotaDisplay } from '@/lib/channel-plan-quota-display'

/** 卡片渲染所需的完整投影 */
export interface ChannelCardData {
  channel: Channel
  /** 供应商展示名（provider 标签） */
  providerLabel: string
  /** 模型数摘要，例如「3 个模型已启用 / 共 8 个」 */
  modelCountLabel: string
  /** 有缓存额度时展示的短摘要；没有查询结果时为 null */
  quotaSummary: string | null
  /** 已按 maxLength 截断的最近错误；没有错误时为 null */
  errorSummary: string | null
  /** 未截断的错误文案，供 title 提示 */
  errorTitle: string | null
}

export interface ChannelCardBuildOptions {
  /** 读取该渠道的额度结果；返回 null 表示暂无数据 */
  quotaOf?: (channel: Channel) => ChannelPlanQuotaResult | null
  /** 读取该渠道的最近错误 */
  errorOf?: (channel: Channel) => string | null | undefined
  /** 错误摘要最大字符数，默认 72 */
  errorMaxLength?: number
}

const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** 已启用渠道优先；同状态内按名称排序，同名保持传入顺序（稳定排序）。 */
export function compareChannelsForCards(a: Channel, b: Channel): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
  return NAME_COLLATOR.compare(a.name, b.name)
}

export function sortChannelsForCards(channels: readonly Channel[]): Channel[] {
  return channels
    .map((channel, index) => ({ channel, index }))
    .sort((a, b) => compareChannelsForCards(a.channel, b.channel) || a.index - b.index)
    .map((item) => item.channel)
}

export function formatChannelModelCount(channel: Channel): string {
  const total = channel.models.length
  if (total === 0) return '暂无模型'
  const enabled = channel.models.filter((model) => model.enabled).length
  return `${enabled} 个模型已启用 / 共 ${total} 个`
}

/** 折叠换行与连续空白，避免错误栈把卡片撑高。 */
function normalizeError(message: string | null | undefined): string | null {
  const normalized = message?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized : null
}

/** 单行错误摘要；超长时保留 maxLength - 1 个字符并追加省略号。 */
export function summarizeChannelError(message: string | null | undefined, maxLength = 72): string | null {
  const normalized = normalizeError(message)
  if (!normalized) return null
  const limit = Math.max(8, Math.floor(maxLength))
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

/**
 * 模型清单是否有实质变化。
 *
 * 仅按 id 比较内容并忽略顺序：拉取结果顺序变化不应触发一次无意义的写库，
 * 否则会刷新渠道 updatedAt 并使额度缓存失效。
 */
export function hasModelListChanges(previous: readonly ChannelModel[], next: readonly ChannelModel[]): boolean {
  if (previous.length !== next.length) return true
  const previousById = new Map(previous.map((model) => [model.id, modelSignature(model)]))
  return next.some((model) => previousById.get(model.id) !== modelSignature(model))
}

function modelSignature(model: ChannelModel): string {
  return [
    model.name,
    model.enabled ? '1' : '0',
    model.source ?? '',
    model.contextWindow ?? '',
    model.builtInContextWindow ?? '',
  ].join('\u0000')
}

/**
 * 额度查询是否属于「失败」而非「该供应商未提供窗口」。
 *
 * 供应商没有 5H/周窗口是正常数据形态，不应在卡片上标记为错误。
 */
export function isQuotaFailure(result: ChannelPlanQuotaResult | null | undefined): boolean {
  if (!result || result.supported) return false
  return Boolean(result.message && /失败|超时|无效|无法|错误/.test(result.message))
}

export function buildChannelCards(
  channels: readonly Channel[],
  options: ChannelCardBuildOptions = {},
): ChannelCardData[] {
  return sortChannelsForCards(channels).map((channel) => {
    const quota = options.quotaOf?.(channel) ?? null
    const quotaDisplay = quota ? getPlanQuotaDisplay(quota, channel.provider) : null
    const rawError = options.errorOf?.(channel)
    return {
      channel,
      providerLabel: PROVIDER_LABELS[channel.provider] ?? channel.provider,
      modelCountLabel: formatChannelModelCount(channel),
      quotaSummary: quotaDisplay?.summary ?? null,
      errorSummary: summarizeChannelError(rawError, options.errorMaxLength),
      errorTitle: normalizeError(rawError),
    }
  })
}
