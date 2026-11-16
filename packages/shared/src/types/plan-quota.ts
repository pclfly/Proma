import type { ChannelPlanQuotaCredits, ProviderType } from './channel'

/**
 * 输入框常驻额度汇总的类型契约。
 *
 * 与单渠道的 `ChannelPlanQuotaResult` 不同，这里是「当前启用渠道」的只读投影：
 * 只汇总 provider 已经返回的窗口与积分，不推断、不补零、不保存凭据。
 */

/** 展示窗口类型，与单渠道额度保持一致。 */
export type PlanQuotaWindowType = '5h' | 'weekly' | 'custom'

/** 单个额度窗口（5 小时、每周或供应商自定义窗口）。 */
export interface PlanQuotaWindow {
  type: PlanQuotaWindowType
  label: string
  remainingPercent: number
  usedPercent: number
  /** 余额等无法自然转成百分比时的展示值。 */
  remainingLabel?: string
  /** 是否展示进度条，默认展示。 */
  showProgress?: boolean
  /** 重置时间戳（毫秒）。 */
  resetAt?: number
}

/** 启用的单个额度来源。 */
export interface PlanQuotaSource {
  /** 渠道 ID；仅用于区分来源，不包含任何凭据。 */
  channelId: string
  provider: ProviderType
  /** 用户可读的来源名称，通常为渠道名。 */
  label: string
  /** 订阅 Plan 展示名称。 */
  planName?: string
  /** Kimi 会员档位等供应商返回的等级名。 */
  tier?: string
  windows: PlanQuotaWindow[]
  /** 仅在供应商返回积分制额度时存在。 */
  credits?: ChannelPlanQuotaCredits
  /** 最近一次成功查询的时间戳（毫秒）。 */
  updatedAt: number
  /** 本次查询失败或供应商不支持时的原因。 */
  error?: string
  /** 当前来源是否保留了上一次成功结果。 */
  stale?: boolean
}

/** 多来源额度快照。 */
export interface PlanQuotaSnapshot {
  sources: PlanQuotaSource[]
  /** 最近一次成功汇总的时间戳；从未成功时为 0。 */
  refreshedAt: number
  /** 是否包含过期/失败后保留的数据。 */
  stale: boolean
}

/**
 * 额度相关 IPC 通道常量。
 *
 * 四个层（shared / main / preload / renderer）必须保持一致。
 */
export const PLAN_QUOTA_IPC_CHANNELS = {
  /** 读取内存或缓存中的额度快照（不主动联网） */
  GET: 'plan-quota:get',
  /** 按需刷新额度快照 */
  REFRESH: 'plan-quota:refresh',
  /** 主进程刷新完成后推送最新快照 */
  CHANGED: 'plan-quota:changed',
} as const
