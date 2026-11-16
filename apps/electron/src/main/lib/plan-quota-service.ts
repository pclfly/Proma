/**
 * 额度汇总的服务层接线。
 *
 * - 惰性创建 store：只有渲染层请求额度时才读取缓存/渠道；
 * - 统一把刷新结果广播给所有窗口；
 * - 通过轻量信号模块接收 agent-service 的使用事件，避免 IPC 层循环依赖。
 */

import { BrowserWindow } from 'electron'
import { PLAN_QUOTA_IPC_CHANNELS } from '@proma/shared'
import type { PlanQuotaSnapshot } from '@proma/shared'
import { getChannelPlanQuota, listChannels } from './channel-manager'
import { getPlanQuotaCachePath } from './config-paths'
import { setPlanQuotaUsageListener } from './plan-quota-signal'
import { createPlanQuotaStore } from './plan-quota-store'
import type { PlanQuotaStore, PlanQuotaRefreshTrigger } from './plan-quota-store'

let store: PlanQuotaStore | null = null
let usagePending = false

function broadcast(snapshot: PlanQuotaSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(PLAN_QUOTA_IPC_CHANNELS.CHANGED, snapshot)
  }
}

function ensureStore(): PlanQuotaStore {
  if (store) return store
  store = createPlanQuotaStore({
    listChannels: () => listChannels(),
    queryQuota: (channelId) => getChannelPlanQuota(channelId),
    cachePath: getPlanQuotaCachePath(),
    onChange: broadcast,
  })
  if (usagePending) {
    usagePending = false
    store.noteUsage()
  }
  return store
}

/** 读取当前快照；不会主动联网。 */
export function getPlanQuotaSnapshot(): PlanQuotaSnapshot {
  return ensureStore().getSnapshot()
}

/** 按需刷新全部启用渠道的额度。 */
export function refreshPlanQuotas(trigger: PlanQuotaRefreshTrigger = 'manual'): Promise<PlanQuotaSnapshot> {
  return ensureStore().refresh(trigger)
}

/**
 * 一轮对话结束后记录一次使用。
 *
 * 只安排一次节流刷新；若渲染层尚未请求过额度，则只记标记，不提前启动任务。
 */
function handlePlanQuotaUsage(): void {
  if (store) {
    store.noteUsage()
    return
  }
  usagePending = true
}

/** 渠道增删改后调用，触发一次短延迟刷新。 */
export function notePlanQuotaChannelsChanged(): void {
  store?.noteChannelsChanged()
}

/** 应用退出时清理尚未触发的延迟刷新。 */
export function disposePlanQuotaService(): void {
  store?.dispose()
  store = null
}

// agent-service 只依赖轻量信号模块，订阅在额度服务加载时注册。
setPlanQuotaUsageListener(handlePlanQuotaUsage)
