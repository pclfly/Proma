/**
 * 输入框额度胶囊的 Jotai 状态。
 *
 * 刷新时机：首次进入、渠道签名变化、用户手动刷新或主进程推送。
 * 没有任何 setInterval / 后台轮询；倒计时由组件本地的秒表负责。
 */

import { atom } from 'jotai'
import type { Channel, PlanQuotaSnapshot } from '@proma/shared'
import { channelsAtom } from './channel-atoms'

export interface PlanQuotaState {
  snapshot: PlanQuotaSnapshot | null
  /** 快照生成时的启用渠道签名，用于换号/换渠道时隐藏旧数据。 */
  signature: string
  loading: boolean
  error?: string
}

const INITIAL_STATE: PlanQuotaState = {
  snapshot: null,
  signature: '',
  loading: false,
}

export const planQuotaStateAtom = atom<PlanQuotaState>(INITIAL_STATE)

/** 渠道启用状态与凭据版本的签名；updatedAt 变化即视为换号。 */
export function planQuotaChannelsSignature(channels: readonly Channel[]): string {
  return channels
    .filter((channel) => channel.enabled)
    .map((channel) => `${channel.id}:${channel.updatedAt}:${channel.provider}:${channel.baseUrl}`)
    .sort()
    .join('|')
}

/** 只有签名一致时才允许把快照展示给当前渠道。 */
export function currentPlanQuotaSnapshot(
  state: PlanQuotaState,
  signature: string,
): PlanQuotaSnapshot | null {
  return state.signature === signature ? state.snapshot : null
}

let inflightRefresh: Promise<PlanQuotaSnapshot> | null = null

/** 按需刷新；auto 会跳过 60 秒内且不 stale 的同一渠道快照。 */
export const refreshPlanQuotaAtom = atom(null, async (get, set, mode: 'auto' | 'manual' = 'auto') => {
  const signature = planQuotaChannelsSignature(get(channelsAtom))
  const state = get(planQuotaStateAtom)
  const recentlyRefreshed = state.snapshot !== null
    && state.snapshot.refreshedAt > 0
    && Date.now() - state.snapshot.refreshedAt < 60_000
  if (mode === 'auto' && state.signature === signature && recentlyRefreshed && !state.snapshot?.stale) {
    return
  }

  set(planQuotaStateAtom, { ...state, loading: true })
  inflightRefresh ??= window.electronAPI.refreshPlanQuotas()
  try {
    const snapshot = await inflightRefresh
    const latestSignature = planQuotaChannelsSignature(get(channelsAtom))
    set(planQuotaStateAtom, { snapshot, signature: latestSignature, loading: false })
  } catch (error) {
    set(planQuotaStateAtom, {
      ...get(planQuotaStateAtom),
      loading: false,
      error: error instanceof Error ? error.message : '额度刷新失败',
    })
  } finally {
    inflightRefresh = null
  }
})

/** 首次进入：先读缓存快照，再决定是否需要按需刷新。 */
export const ensurePlanQuotaAtom = atom(null, async (get, set) => {
  const state = get(planQuotaStateAtom)
  if (state.snapshot || state.loading) return

  try {
    const snapshot = await window.electronAPI.getPlanQuotaSnapshot()
    const signature = planQuotaChannelsSignature(get(channelsAtom))
    set(planQuotaStateAtom, { snapshot, signature, loading: false })
  } catch {
    // 读取缓存失败不阻塞后续刷新；错误由 refresh 分支统一呈现。
  }

  const latest = get(planQuotaStateAtom)
  if (!latest.snapshot || latest.snapshot.refreshedAt === 0 || latest.snapshot.stale) {
    await set(refreshPlanQuotaAtom, 'auto')
  }
})

/** 主进程推送的快照（渠道变化或使用后刷新完成）。 */
export const applyPlanQuotaSnapshotAtom = atom(null, (get, set, snapshot: PlanQuotaSnapshot) => {
  const signature = planQuotaChannelsSignature(get(channelsAtom))
  set(planQuotaStateAtom, { snapshot, signature, loading: false })
})
