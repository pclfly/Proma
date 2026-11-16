/**
 * 定时任务运行历史的纯函数工具
 *
 * 与 Electron / 文件系统解耦，便于单测覆盖：
 * - 旧数据归一化（补 runId、纠正非法状态、截断超限历史）
 * - 启动恢复（把上次进程遗留的 running 记录改标为 interrupted）
 */

import {
  AUTOMATION_MAX_HISTORY,
  AUTOMATION_RUN_INTERRUPTED_ERROR,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from '@proma/shared'

const VALID_RUN_STATUSES: ReadonlySet<string> = new Set<AutomationRunStatus>([
  'running',
  'success',
  'error',
  'skipped',
  'interrupted',
])

const VALID_RUN_TRIGGERS: ReadonlySet<string> = new Set<AutomationRunTrigger>([
  'schedule',
  'manual',
])

export interface AutomationRunHistoryNormalization {
  runHistory: AutomationRun[]
  /** 是否发生字段补全 / 清理，调用方据此决定是否写回磁盘 */
  changed: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 归一化单条历史记录；缺少 runAt 等关键字段的非法条目直接丢弃（返回 undefined） */
function normalizeRunRecord(
  raw: unknown,
  position: number,
): { run: AutomationRun; changed: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Partial<AutomationRun> & Record<string, unknown>
  if (!isFiniteNumber(source.runAt)) return undefined

  let changed = false
  const runAt = source.runAt

  let status: AutomationRunStatus
  if (typeof source.status === 'string' && VALID_RUN_STATUSES.has(source.status)) {
    status = source.status as AutomationRunStatus
  } else {
    // 非法状态不能丢弃整条记录（用户仍应看到这次运行发生过），按失败处理
    status = 'error'
    changed = true
  }

  let runId: string
  if (typeof source.runId === 'string' && source.runId.trim().length > 0) {
    runId = source.runId
  } else {
    // v5 之前的记录没有 runId：用稳定可复现的 legacy id 兜底，再次迁移不会变化
    runId = `legacy-${runAt}-${position}`
    changed = true
  }

  let sessionId: string
  if (typeof source.sessionId === 'string') {
    sessionId = source.sessionId
  } else {
    sessionId = ''
    changed = true
  }

  let finishedAt: number | undefined
  if (isFiniteNumber(source.finishedAt)) {
    finishedAt = source.finishedAt
  } else {
    finishedAt = undefined
    if (source.finishedAt !== undefined) changed = true
  }

  let durationMs: number | undefined
  if (isFiniteNumber(source.durationMs) && source.durationMs >= 0) {
    durationMs = source.durationMs
  } else {
    durationMs = undefined
    if (source.durationMs !== undefined) changed = true
  }

  // 终态记录补 finishedAt，避免前端在旧数据上无法展示完成时间
  if (status !== 'running' && finishedAt === undefined && durationMs !== undefined) {
    finishedAt = runAt + durationMs
    changed = true
  }

  let error: string | undefined
  if (typeof source.error === 'string' && source.error.length > 0) {
    error = source.error
  } else {
    error = undefined
    if (source.error !== undefined) changed = true
  }

  let skipReason: string | undefined
  if (typeof source.skipReason === 'string' && source.skipReason.length > 0) {
    skipReason = source.skipReason
  } else {
    skipReason = undefined
    if (source.skipReason !== undefined) changed = true
  }

  let trigger: AutomationRunTrigger | undefined
  if (typeof source.trigger === 'string' && VALID_RUN_TRIGGERS.has(source.trigger)) {
    trigger = source.trigger as AutomationRunTrigger
  } else {
    trigger = undefined
    if (source.trigger !== undefined) changed = true
  }

  return {
    run: { runId, runAt, sessionId, status, finishedAt, durationMs, error, skipReason, trigger },
    changed,
  }
}

/**
 * 归一化 runHistory：
 * - 非数组 → 空数组（保留任务本身，不删除任何任务）
 * - 非法条目丢弃，合法条目补 runId / finishedAt
 * - 超过 AUTOMATION_MAX_HISTORY 的尾部记录截断
 */
export function normalizeAutomationRunHistory(raw: unknown): AutomationRunHistoryNormalization {
  if (!Array.isArray(raw)) {
    return { runHistory: [], changed: raw !== undefined }
  }

  const runHistory: AutomationRun[] = []
  let changed = raw.length > AUTOMATION_MAX_HISTORY

  for (let position = 0; position < raw.length; position++) {
    if (runHistory.length >= AUTOMATION_MAX_HISTORY) break
    const normalized = normalizeRunRecord(raw[position], position)
    if (!normalized) {
      changed = true
      continue
    }
    if (normalized.changed) changed = true
    runHistory.push(normalized.run)
  }

  return { runHistory, changed }
}

/**
 * 把上次进程遗留的 running 记录标记为 interrupted（原地修改）。
 * 只改状态与结束字段，不推进 nextRunAt / runCount，避免重启后盲目重跑或重复计数。
 * @returns 被改标的记录条数
 */
export function markInterruptedRuns(runs: AutomationRun[], now: number): number {
  const finishedAt = isFiniteNumber(now) ? now : Date.now()
  let recovered = 0

  for (const run of runs) {
    if (run.status !== 'running') continue
    run.status = 'interrupted'
    run.error = AUTOMATION_RUN_INTERRUPTED_ERROR
    run.finishedAt = finishedAt
    if (run.durationMs === undefined) {
      run.durationMs = Math.max(0, finishedAt - run.runAt)
    }
    recovered++
  }

  return recovered
}
