/**
 * 定时任务运行生命周期控制器
 *
 * 把「启动即落盘 running → 会话创建后立即返回 → 结束按 runId 结算一次」的时序逻辑
 * 从 automation-scheduler 中抽出来，依赖全部可注入，便于在不启动 Electron / 真实定时器的情况下测试：
 * - 启动：先写 running 记录，再解析/创建子会话，然后在不 await 执行的前提下返回摘要
 * - 结算：onError / onComplete / 超时 / 启动异常都走同一出口，settled 守卫保证只结算一次
 * - 重入：同一任务运行中再次触发时写一条 skipped 记录并返回 started:false
 */

import type {
  Automation,
  AutomationRun,
  AutomationRunStartResult,
  AutomationRunTrigger,
} from '@proma/shared'
import type {
  AutomationRunFinishResult,
  AutomationRunSettlement,
} from './automation-manager'

/** 已确定的执行目标会话 */
export interface AutomationRunSessionTarget {
  sessionId: string
  /** true = 复用已有子会话；false = 新建 */
  reused: boolean
}

/** 供 headless 运行回调的出口；先到者生效 */
export interface AutomationRunCallbacks {
  onError: (error: string) => void
  onComplete: () => void
}

export interface AutomationRunControllerDeps {
  now(): number
  createRunId(): string
  getAutomation(id: string): Automation | undefined
  /** 落一条运行记录（running 或 skipped） */
  insertRun(automationId: string, run: AutomationRun): void
  /** 为进行中的运行补记子会话 ID */
  attachSession(automationId: string, runId: string, sessionId: string): void
  /** 按 runId 结算，重复调用由实现保证幂等 */
  settleRun(automationId: string, runId: string, settlement: AutomationRunSettlement): AutomationRunFinishResult
  /** 解析/创建本轮要执行的子会话；失败时本轮以 error 结算 */
  resolveSession(automation: Automation, runAt: number): Promise<AutomationRunSessionTarget>
  /** 启动 headless 执行（不要 await 完成） */
  startSessionRun(
    automation: Automation,
    target: AutomationRunSessionTarget,
    runAt: number,
    callbacks: AutomationRunCallbacks,
  ): Promise<void>
  /** 结算生效后的副作用（通知、失败退避等） */
  afterSettled(automation: Automation, run: AutomationRun): void
  /** 列表变更广播 */
  broadcast(): void
  /** 单轮执行超时上限 */
  timeoutMs: number
  /** 超时定时器；返回 cancel 函数。默认使用 setTimeout */
  setTimer?(callback: () => void, timeoutMs: number): () => void
}

export interface AutomationRunController {
  /** 启动一轮运行；会话创建完成后立即返回，不等待任务执行结束 */
  start(automationId: string, trigger: AutomationRunTrigger): Promise<AutomationRunStartResult>
  /** 该任务是否有一轮正在执行（重入保护） */
  isRunning(automationId: string): boolean
}

function defaultSetTimer(callback: () => void, timeoutMs: number): () => void {
  const timer = setTimeout(callback, timeoutMs)
  return () => clearTimeout(timer)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

export function createAutomationRunController(deps: AutomationRunControllerDeps): AutomationRunController {
  const runningAutomations = new Set<string>()
  const setTimer = deps.setTimer ?? defaultSetTimer

  /** 结算并按需触发副作用；写入失败只记录日志，避免影响运行收尾 */
  const settle = (
    automationId: string,
    runId: string,
    settlement: AutomationRunSettlement,
  ): AutomationRunFinishResult | undefined => {
    let result: AutomationRunFinishResult
    try {
      result = deps.settleRun(automationId, runId, settlement)
    } catch (error) {
      console.error(`[定时任务] 结算运行记录失败: automation=${automationId}, run=${runId}`, error)
      return undefined
    }
    if (result.applied && result.automation && result.run) {
      try {
        deps.afterSettled(result.automation, result.run)
      } catch (error) {
        console.error(`[定时任务] 运行结算后处理失败: automation=${automationId}`, error)
      }
    }
    return result
  }

  const insertRun = (automationId: string, run: AutomationRun): boolean => {
    try {
      deps.insertRun(automationId, run)
      return true
    } catch (error) {
      console.error(`[定时任务] 写入运行记录失败: automation=${automationId}`, error)
      return false
    }
  }

  const start = async (
    automationId: string,
    trigger: AutomationRunTrigger,
  ): Promise<AutomationRunStartResult> => {
    const automation = deps.getAutomation(automationId)
    if (!automation) {
      return { started: false, id: automationId, phase: 'not-found', reason: `定时任务不存在: ${automationId}` }
    }
    // 草稿态（缺 channelId / workspaceId）拒绝运行，兜底前端 disabled 防止 IPC 绕过
    if (!automation.channelId || !automation.workspaceId) {
      return { started: false, id: automationId, phase: 'not-runnable', reason: '请先为该任务配置模型与项目' }
    }
    if (trigger === 'schedule' && !automation.active) {
      return { started: false, id: automationId, phase: 'paused', reason: '任务已暂停' }
    }

    // 重入保护：上一轮未结束时不再并发执行，但要留下一条跳过记录
    if (runningAutomations.has(automationId)) {
      console.log(`[定时任务] ${automation.name} 上一轮尚未结束，跳过本轮`)
      const skipAt = deps.now()
      insertRun(automationId, {
        runId: deps.createRunId(),
        runAt: skipAt,
        sessionId: '',
        status: 'skipped',
        finishedAt: skipAt,
        durationMs: 0,
        skipReason: '上一轮尚未结束',
        trigger,
      })
      deps.broadcast()
      return { started: false, id: automationId, phase: 'busy', reason: '上一轮尚未结束' }
    }

    runningAutomations.add(automationId)
    const runAt = deps.now()
    const runId = deps.createRunId()
    const startedRun: AutomationRun = {
      runId,
      runAt,
      sessionId: '',
      status: 'running',
      trigger,
    }

    // 关键：执行前先把 running 落盘，进程崩溃后启动恢复才能把这条记录标为中断
    if (!insertRun(automationId, startedRun)) {
      runningAutomations.delete(automationId)
      return { started: false, id: automationId, runId, phase: 'failed', reason: '运行记录写入失败' }
    }
    deps.broadcast()

    let target: AutomationRunSessionTarget
    try {
      target = await deps.resolveSession(automation, runAt)
    } catch (error) {
      runningAutomations.delete(automationId)
      const message = errorMessage(error)
      const finishedAt = deps.now()
      settle(automationId, runId, { status: 'error', error: message, finishedAt })
      deps.broadcast()
      return { started: false, id: automationId, runId, phase: 'failed', reason: message }
    }

    try {
      deps.attachSession(automationId, runId, target.sessionId)
    } catch (error) {
      // 会话已创建但补记失败：不影响本轮执行，结算时 settlement.sessionId 仍会写回记录
      console.error(`[定时任务] 补记运行会话失败: automation=${automationId}, run=${runId}`, error)
    }

    let settled = false
    let cancelTimeout: () => void = () => {}

    const finish = (status: 'success' | 'error', error?: string): void => {
      if (settled) return
      settled = true
      cancelTimeout()
      runningAutomations.delete(automationId)
      const finishedAt = deps.now()
      settle(automationId, runId, {
        status,
        sessionId: target.sessionId,
        finishedAt,
        durationMs: Math.max(0, finishedAt - runAt),
        error,
      })
      deps.broadcast()
    }

    cancelTimeout = setTimer(() => {
      console.warn(`[定时任务] ${automation.name} 执行超时，强制结束`)
      finish('error', `执行超时（超过 ${deps.timeoutMs / 3_600_000} 小时）`)
    }, deps.timeoutMs)

    // 不 await：会话创建完成后立即返回，任务在后台继续执行
    void Promise.resolve()
      .then(() =>
        deps.startSessionRun(automation, target, runAt, {
          onError: (error) => finish('error', error),
          onComplete: () => finish('success'),
        }),
      )
      .catch((error) => finish('error', errorMessage(error)))

    return {
      started: true,
      id: automationId,
      runId,
      sessionId: target.sessionId,
      phase: 'running',
      ...(trigger === 'manual' && !automation.active ? { note: '任务已暂停，本次仅手动运行一次' } : {}),
    }
  }

  return {
    start,
    isRunning: (automationId) => runningAutomations.has(automationId),
  }
}
