/**
 * 定时任务运行控制器 BDD 测试
 *
 * 用可注入依赖替代真实 Electron / Agent 运行时 / 定时器，覆盖启动即时返回、按 runId 结算一次、
 * 超时与迟到回调、重入跳过、暂停与配置不完整等情况。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Automation, AutomationRun } from '@proma/shared'
import {
  createAutomationRunController,
  type AutomationRunCallbacks,
  type AutomationRunControllerDeps,
  type AutomationRunSessionTarget,
} from './automation-run-controller'
import type { AutomationRunFinishResult, AutomationRunSettlement } from './automation-manager'

function createAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: '每日进展汇总',
    prompt: '汇总昨天的进展',
    active: true,
    scheduleType: 'interval',
    intervalMinutes: 10,
    channelId: 'channel-1',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 1_000_000,
    runHistory: [],
    ...overrides,
  }
}

interface HarnessOptions {
  automation?: Automation
  resolveSession?: () => Promise<AutomationRunSessionTarget>
  startSessionRun?: (
    automation: Automation,
    target: AutomationRunSessionTarget,
    runAt: number,
    callbacks: AutomationRunCallbacks,
  ) => Promise<void>
  insertRun?: (run: AutomationRun) => void
}

function createHarness(options: HarnessOptions = {}) {
  const automation = options.automation ?? createAutomation()
  const runs: AutomationRun[] = []
  const settleCalls: Array<{ runId: string; settlement: AutomationRunSettlement }> = []
  const settledRunIds: string[] = []
  const startSnapshots: Array<Array<{ runId: string; status: string }>> = []

  let callbacks: AutomationRunCallbacks | undefined
  let timerCallback: (() => void) | undefined
  let timerCancelled = false
  let runSequence = 0
  let clock = 10_000

  const deps: AutomationRunControllerDeps = {
    now: () => {
      clock += 10
      return clock
    },
    createRunId: () => {
      runSequence += 1
      return `run-${runSequence}`
    },
    getAutomation: (id) => (id === automation.id ? automation : undefined),
    insertRun: (_id, run) => {
      if (options.insertRun) options.insertRun(run)
      runs.push(run)
    },
    attachSession: (_id, runId, sessionId) => {
      const run = runs.find((item) => item.runId === runId)
      if (run) run.sessionId = sessionId
    },
    settleRun: (_id, runId, settlement): AutomationRunFinishResult => {
      settleCalls.push({ runId, settlement })
      const run = runs.find((item) => item.runId === runId)
      if (!run) return { applied: false, reason: 'run-missing' }
      if (run.status !== 'running') return { applied: false, reason: 'already-settled', automation, run }
      run.status = settlement.status
      run.finishedAt = settlement.finishedAt
      run.durationMs = settlement.durationMs
      run.error = settlement.error
      run.skipReason = settlement.skipReason
      if (settlement.sessionId) run.sessionId = settlement.sessionId
      return { applied: true, automation, run }
    },
    resolveSession: options.resolveSession ?? (async () => ({ sessionId: 'session-1', reused: false })),
    startSessionRun: options.startSessionRun ?? (async (_automation, _target, _runAt, runCallbacks) => {
      startSnapshots.push(runs.map((run) => ({ runId: run.runId, status: run.status })))
      callbacks = runCallbacks
    }),
    afterSettled: (_automation, run) => {
      settledRunIds.push(run.runId)
    },
    broadcast: () => { /* 测试不关心广播次数 */ },
    timeoutMs: 2 * 60 * 60 * 1000,
    setTimer: (callback) => {
      timerCallback = callback
      return () => {
        timerCancelled = true
      }
    },
  }

  return {
    automation,
    controller: createAutomationRunController(deps),
    runs,
    settleCalls,
    settledRunIds,
    startSnapshots,
    getCallbacks: () => callbacks,
    fireTimeout: () => timerCallback?.(),
    isTimerCancelled: () => timerCancelled,
  }
}

/** 正常运行时会打印预期内的错误/超时日志，测试里静音以保持输出可读 */
let restoreConsole: Array<() => void> = []

beforeEach(() => {
  restoreConsole = [
    spyOn(console, 'error').mockImplementation(() => {}),
    spyOn(console, 'warn').mockImplementation(() => {}),
    spyOn(console, 'log').mockImplementation(() => {}),
  ]
})

afterEach(() => {
  for (const restore of restoreConsole) restore()
  restoreConsole = []
})

describe('启动即确认', () => {

  test('Given 任务可运行 When 立即运行 Then 先落 running 记录并立即返回启动摘要', async () => {
    const harness = createHarness()

    const result = await harness.controller.start('auto-1', 'manual')

    expect(result).toMatchObject({
      started: true,
      id: 'auto-1',
      phase: 'running',
      runId: 'run-1',
      sessionId: 'session-1',
    })
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]).toMatchObject({ runId: 'run-1', status: 'running', trigger: 'manual' })
    // 执行开始时 running 已经落盘
    expect(harness.startSnapshots[0]).toEqual([{ runId: 'run-1', status: 'running' }])
    // 尚未结算，说明 start 没有等待任务执行完成
    expect(harness.settleCalls).toHaveLength(0)
    expect(harness.controller.isRunning('auto-1')).toBe(true)
  })

  test('Given 任务运行中 When 再次立即运行 Then started:false/busy 并落一条 skipped 记录', async () => {
    const harness = createHarness()
    await harness.controller.start('auto-1', 'manual')

    const second = await harness.controller.start('auto-1', 'manual')

    expect(second).toMatchObject({ started: false, id: 'auto-1', phase: 'busy' })
    expect(second.reason).toBe('上一轮尚未结束')
    expect(harness.runs[1]).toMatchObject({ status: 'skipped', skipReason: '上一轮尚未结束' })
    expect(harness.settleCalls).toHaveLength(0)
  })

  test('Given 任务配置不完整 When 立即运行 Then started:false/not-runnable 且不落记录', async () => {
    const harness = createHarness({ automation: createAutomation({ workspaceId: undefined }) })

    const result = await harness.controller.start('auto-1', 'manual')

    expect(result).toMatchObject({ started: false, phase: 'not-runnable' })
    expect(result.reason).toBe('请先为该任务配置模型与项目')
    expect(harness.runs).toHaveLength(0)
  })

  test('Given 任务已暂停 When 调度触发 Then started:false/paused；手动运行仍允许并给出说明', async () => {
    const harness = createHarness({ automation: createAutomation({ active: false }) })

    const scheduled = await harness.controller.start('auto-1', 'schedule')
    expect(scheduled).toMatchObject({ started: false, phase: 'paused' })
    expect(harness.runs).toHaveLength(0)

    const manual = await harness.controller.start('auto-1', 'manual')
    expect(manual.started).toBe(true)
    expect(manual.note).toBe('任务已暂停，本次仅手动运行一次')
    expect(harness.runs[0]?.trigger).toBe('manual')
  })

  test('Given 任务不存在 When 启动 Then 返回 not-found', async () => {
    const harness = createHarness()

    const result = await harness.controller.start('missing', 'manual')

    expect(result).toMatchObject({ started: false, id: 'missing', phase: 'not-found' })
  })

  test('Given 会话创建失败 When 启动 Then started:false/failed 且本轮以 error 结算', async () => {
    const harness = createHarness({
      resolveSession: async () => { throw new Error('会话创建失败') },
    })

    const result = await harness.controller.start('auto-1', 'manual')

    expect(result).toMatchObject({ started: false, phase: 'failed', reason: '会话创建失败' })
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]?.status).toBe('error')
    expect(harness.settleCalls).toHaveLength(1)
    expect(harness.settledRunIds).toEqual(['run-1'])
    expect(harness.controller.isRunning('auto-1')).toBe(false)
  })

  test('Given running 记录写入失败 When 启动 Then 不执行任务并返回 failed', async () => {
    const harness = createHarness({
      insertRun: () => { throw new Error('磁盘写入失败') },
    })

    const result = await harness.controller.start('auto-1', 'manual')

    expect(result).toMatchObject({ started: false, phase: 'failed', reason: '运行记录写入失败' })
    expect(harness.startSnapshots).toHaveLength(0)
    expect(harness.controller.isRunning('auto-1')).toBe(false)
  })
})

describe('按 runId 结算一次', () => {
  test('Given 运行开始后回调完成 When 结算 Then 只结算一次并释放运行槽位', async () => {
    const harness = createHarness()
    await harness.controller.start('auto-1', 'manual')

    harness.getCallbacks()?.onComplete()

    expect(harness.settleCalls).toHaveLength(1)
    expect(harness.settleCalls[0]).toMatchObject({
      runId: 'run-1',
      settlement: { status: 'success', sessionId: 'session-1' },
    })
    expect(harness.runs[0]?.status).toBe('success')
    expect(harness.runs[0]?.finishedAt).toBeNumber()
    expect(harness.settledRunIds).toEqual(['run-1'])
    expect(harness.isTimerCancelled()).toBe(true)
    expect(harness.controller.isRunning('auto-1')).toBe(false)
  })

  test('Given 运行超时 When 迟到的 onComplete 到达 Then 只保留超时结算一次', async () => {
    const harness = createHarness()
    await harness.controller.start('auto-1', 'manual')

    harness.fireTimeout()
    harness.getCallbacks()?.onComplete()

    expect(harness.settleCalls).toHaveLength(1)
    expect(harness.settleCalls[0]?.settlement.status).toBe('error')
    expect(harness.settleCalls[0]?.settlement.error).toContain('执行超时')
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]?.status).toBe('error')
    expect(harness.settledRunIds).toEqual(['run-1'])
  })

  test('Given 上一轮已超时结算且新一轮已开始 When 旧回调到达 Then 不覆盖新一轮记录', async () => {
    const harness = createHarness()
    await harness.controller.start('auto-1', 'manual')
    const firstRunCallbacks = harness.getCallbacks()
    harness.fireTimeout()

    const second = await harness.controller.start('auto-1', 'manual')
    expect(second.started).toBe(true)
    expect(harness.runs[1]).toMatchObject({ runId: 'run-2', status: 'running' })

    firstRunCallbacks?.onComplete()

    expect(harness.runs[1]).toMatchObject({ runId: 'run-2', status: 'running' })
    expect(harness.settleCalls).toHaveLength(1)
    expect(harness.runs[0]?.status).toBe('error')
    expect(harness.controller.isRunning('auto-1')).toBe(true)
  })

  test('Given 执行 promise 直接 reject When 启动后 Then 以 error 结算一次', async () => {
    const harness = createHarness({
      startSessionRun: async () => { throw new Error('运行时崩溃') },
    })

    await harness.controller.start('auto-1', 'manual')
    // 让 startSessionRun 的 rejection 走完 settle（多轮微任务）
    for (let index = 0; index < 5; index++) await Promise.resolve()

    expect(harness.settleCalls).toHaveLength(1)
    expect(harness.settleCalls[0]?.settlement).toMatchObject({ status: 'error', error: '运行时崩溃' })
    expect(harness.controller.isRunning('auto-1')).toBe(false)
  })
})
