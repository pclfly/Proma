/**
 * 定时任务（Automation）调度器
 *
 * 核心设计（见 .context/plan/automation-feature.md）：
 * - 用「下次触发时间戳 + 短 tick 轮询」而非长 setInterval，避免系统休眠导致的定时器漂移
 * - 子会话归属按 sessionMode 决定：
 *     · daily（默认）：同一自然日内的触发复用同一个子会话，跨日自动新建（兼顾上下文连续性与成本控制）。
 *       叠加安全阀：同日若上次会话上下文占用率已达 DAILY_CONTEXT_ROLLOVER_THRESHOLD，本次也主动新建，
 *       避免运行刚开始就触发 SDK 自动压缩。
 *     · reuse：始终复用同一个子会话（用户主动选择，长期 token 成本由用户承担）
 * - 强制 bypassPermissions，否则无人值守时写操作会因权限弹窗永久阻塞
 * - 来源会话/目标会话忙时跳过本轮，不排队堆积
 * - 连续失败达上限自动暂停
 * - 启动时恢复：遗留 running 记录标为中断；已过期的 nextRunAt 顺延到下一个完整间隔，避免重启雪崩触发
 *
 * 运行生命周期（启动即落盘 running、按 runId 结算一次、立即返回启动摘要）见 automation-run-controller.ts。
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_IPC_CHANNELS,
  AUTOMATION_DEFAULT_SESSION_MODE,
  type Automation,
  type AutomationRun,
  type AutomationRunStartResult,
} from '@proma/shared'
import {
  listAutomations,
  getAutomation,
  insertAutomationRun,
  attachAutomationRunSession,
  settleAutomationRun,
  recoverInterruptedAutomationRuns,
  updateAutomation,
  setNextRunAt,
  computeNextRunAt,
} from './automation-manager'
import {
  createAutomationRunController,
  type AutomationRunSessionTarget,
} from './automation-run-controller'
import { createAgentSession, updateAgentSessionMeta, getAgentSessionMeta } from './agent-session-manager'
import { getAgentTurnUsage } from './agent-turn-usage-service'
import { runAgentHeadless, isAgentSessionActive } from './agent-service'
import { notifyAutomationRunFinished } from './automation-notification-service'

/** tick 周期：每 30s 检查一次到期任务（短轮询，抗休眠漂移） */
const TICK_INTERVAL_MS = 30_000

/** 单次任务执行的超时上限：2 小时。超时后强制标记为 error 并释放 runningAutomations 槽位 */
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * daily 模式下的上下文占用率切换阈值。
 * 当同日复用的会话上下文占用 ≥ 此值时，本次自动新建会话。
 * 留出与 SDK 自动压缩阈值（约 77.5%）的安全余量，避免本次运行刚开始就被压缩。
 */
const DAILY_CONTEXT_ROLLOVER_THRESHOLD = 0.7

/**
 * 判断两个时间戳是否落在同一个本地自然日。
 * 用 new Date().getFullYear/Month/Date 直接取本地时区年月日，避免引入时区库或字符串解析。
 */
function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function formatWeekdays(days?: number[]): string {
  const normalized = [...new Set(days ?? [])].sort((a, b) => a - b)
  if (normalized.length === 0) return '每天'
  if (normalized.join(',') === '1,2,3,4,5') return '工作日'
  if (normalized.join(',') === '0,6') return '周末'
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return normalized.map((day) => names[day] ?? '').join('、')
}

function formatScheduleLabel(a: Automation): string {
  if (a.scheduleType === 'once') {
    const when = a.scheduledAt
      ? new Date(a.scheduledAt).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : '指定时间'
    return `仅运行一次（${when}）`
  }
  if (a.scheduleType === 'daily') return `每天 ${a.timeOfDay ?? '09:00'}`
  if (a.scheduleType === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[a.dayOfWeek ?? 1]} ${a.timeOfDay ?? '09:00'}`
  }
  if (a.scheduleType === 'monthly') return `每月 ${a.dayOfMonth ?? 1} 号 ${a.timeOfDay ?? '09:00'}`
  const min = a.intervalMinutes
  const intervalLabel = min < 60 ? `每 ${min} 分钟` : min < 1440 ? `每 ${min / 60} 小时` : `每 ${min / 1440} 天`
  const weekdayLabel = a.activeWeekdays && a.activeWeekdays.length > 0 ? `，${formatWeekdays(a.activeWeekdays)}` : ''
  const windowLabel = a.activeWindowStart && a.activeWindowEnd ? `，${a.activeWindowStart}–${a.activeWindowEnd}` : ''
  return `${intervalLabel}${weekdayLabel}${windowLabel}`
}

let tickTimer: NodeJS.Timeout | undefined

/** 向所有渲染窗口广播任务列表变更，触发前端刷新 */
export function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    }
  }
}

/**
 * 解析本轮要执行的子会话
 * - reuse：lastSessionId 存在且会话还活着就复用，否则新建
 * - daily：再叠加一层「同一自然日」+「上下文占用率 < 阈值」双重判断
 *   （基于 automation.lastRunAt 排除 skipped 运行；占用率读不到时按"未知"保守复用）
 * 已被用户手动接管（automationGraduated）的会话不再复用，避免把定时任务消息注入用户的私人会话。
 */
async function resolveRunSession(automation: Automation, runAt: number): Promise<AutomationRunSessionTarget> {
  const sessionMode = automation.sessionMode ?? AUTOMATION_DEFAULT_SESSION_MODE

  let reuseSessionId: string | undefined
  const lastSessionMeta = automation.lastSessionId ? getAgentSessionMeta(automation.lastSessionId) : undefined
  if (lastSessionMeta?.automationGraduated) {
    console.log(`[定时任务] ${automation.name} 上次会话已被用户接管，本次自动开新会话`)
  }
  if (automation.lastSessionId && lastSessionMeta && !lastSessionMeta.automationGraduated) {
    if (lastSessionMeta.workspaceId !== automation.workspaceId) {
      console.warn(`[定时任务] ${automation.name} 上次会话项目已变化，本次自动开新会话`)
    } else if (sessionMode === 'reuse') {
      reuseSessionId = automation.lastSessionId
    } else if (
      sessionMode === 'daily' &&
      automation.lastRunAt &&
      isSameLocalDay(automation.lastRunAt, runAt)
    ) {
      const usageRatio = await getAgentTurnUsage(automation.lastSessionId)
      if (usageRatio === undefined || usageRatio < DAILY_CONTEXT_ROLLOVER_THRESHOLD) {
        reuseSessionId = automation.lastSessionId
      } else {
        console.log(
          `[定时任务] ${automation.name} 上下文占用 ${(usageRatio * 100).toFixed(1)}% 已达阈值 ${DAILY_CONTEXT_ROLLOVER_THRESHOLD * 100}%，本次自动开新会话`,
        )
      }
    }
  }

  if (reuseSessionId) return { sessionId: reuseSessionId, reused: true }

  const created = createAgentSession(automation.name, automation.channelId, automation.workspaceId, automation.modelId)
  updateAgentSessionMeta(created.id, { sourceAutomationId: automation.id })
  return { sessionId: created.id, reused: false }
}

/** 运行收尾副作用：完成通知 + 失败退避（只在结算真正生效时调用一次） */
function afterRunSettled(automation: Automation, run: AutomationRun): void {
  void notifyAutomationRunFinished({ automation, run }).catch((err) => {
    console.error(`[定时任务] 发送完成通知失败: ${automation.name}`, err)
  })

  const latest = getAutomation(automation.id)
  if (
    latest &&
    latest.active &&
    (latest.consecutiveFailures ?? 0) >= AUTOMATION_MAX_CONSECUTIVE_FAILURES
  ) {
    updateAutomation({ id: automation.id, active: false })
    console.warn(`[定时任务] ${automation.name} 连续失败 ${latest.consecutiveFailures} 次，已自动暂停`)
    broadcastChanged()
  }
}

const runController = createAutomationRunController({
  now: () => Date.now(),
  createRunId: () => randomUUID(),
  getAutomation,
  insertRun: insertAutomationRun,
  attachSession: attachAutomationRunSession,
  settleRun: settleAutomationRun,
  resolveSession: resolveRunSession,
  startSessionRun: (automation, target, runAt, callbacks) => runAgentHeadless(
    {
      sessionId: target.sessionId,
      userMessage: automation.prompt + '\n<!--PROMA_SCHEDULED_RUN-->',
      automationContext: `这是 Proma 定时任务「${automation.name}」的自动执行（ID: ${automation.id}，${formatScheduleLabel(automation)}）。这本身就是定时任务，不要建议用户再创建定时任务。直接执行任务即可。如发现本任务连续失败、输出价值低、频率不合适或提示词不完整，可以使用 automation 工具读取并更新当前任务。`,
      channelId: automation.channelId,
      modelId: automation.modelId,
      workspaceId: automation.workspaceId,
      permissionModeOverride: automation.permissionMode ?? 'bypassPermissions',
      triggeredBy: 'automation',
      startedAt: runAt,
    },
    {
      source: 'bridge',
      onError: callbacks.onError,
      onComplete: callbacks.onComplete,
      onTitleUpdated: () => { /* 子会话标题不需要特殊处理 */ },
    },
  ),
  afterSettled: afterRunSettled,
  broadcast: broadcastChanged,
  timeoutMs: RUN_TIMEOUT_MS,
})

/**
 * 立即运行一次（手动触发，不影响调度计时）
 *
 * 会话创建完成后立即返回摘要，不等待任务执行结束；
 * 并发 / 配置不完整 / 启动失败通过 started:false + reason 表达。
 */
export async function runAutomationNow(id: string): Promise<AutomationRunStartResult> {
  const automation = getAutomation(id)
  if (!automation) throw new Error(`定时任务不存在: ${id}`)
  return runController.start(id, 'manual')
}

/** 一个 tick：扫描所有 active 且到期的任务并触发 */
function tick(): void {
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (!automation.active) continue
    // 完整度兜底：老用户可能存在「active=true 但缺工作区 / 渠道」的历史数据，跳过避免运行时崩溃
    if (!automation.channelId || !automation.workspaceId) continue
    if (now < automation.nextRunAt) continue
    if (runController.isRunning(automation.id)) continue
    // 来源会话忙时跳过（极端情况下的额外保险，主要靠新建子会话规避）
    if (automation.sourceSessionId && isAgentSessionActive(automation.sourceSessionId)) {
      continue
    }
    // 不 await，让多个任务可以并行触发；各自有 runController 的重入保护
    void runController.start(automation.id, 'schedule')
  }
}

/**
 * 启动调度器
 *
 * 恢复策略：
 * 1. 先把上次进程遗留的 running 记录标为 interrupted（只改记录，不重跑）；
 * 2. 把已过期的 nextRunAt 顺延到「现在 + 一个完整间隔」，避免应用重启后一堆历史任务在同一 tick 内雪崩触发。
 */
export function startScheduler(): void {
  if (tickTimer) return
  try {
    const recovered = recoverInterruptedAutomationRuns()
    if (recovered > 0) {
      console.warn(`[定时任务] 启动恢复：${recovered} 条未结束的运行已标记为中断，不会自动重跑`)
      broadcastChanged()
    }
  } catch (error) {
    console.error('[定时任务] 启动恢复运行记录失败:', error)
  }
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (automation.active && automation.nextRunAt <= now) {
      setNextRunAt(automation.id, computeNextRunAt(automation, now))
    }
  }
  tickTimer = setInterval(tick, TICK_INTERVAL_MS)
  console.log(`[定时任务] 调度器已启动，tick 周期 ${TICK_INTERVAL_MS / 1000}s`)
}

/** 停止调度器（before-quit 调用） */
export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
    console.log('[定时任务] 调度器已停止')
  }
}
