/**
 * 定时任务调度器接线 BDD 测试
 *
 * automation-scheduler 直接依赖 Electron / Agent 运行时，这里通过模块替身验证接线：
 * 启动时先恢复中断记录、再顺延过期任务；手动运行在配置不完整时立即返回 started:false。
 * 不启动真实 Electron，也不等待真实调度 tick（setInterval 在用例结束前立即清理）。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Automation } from '@proma/shared'

type SchedulerModule = typeof import('./automation-scheduler')

let scheduler: SchedulerModule
let currentAutomations: Automation[] = []
let recoveredCount = 0
const rescheduled: Array<{ id: string; nextRunAt: number }> = []

function createAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-scheduler',
    name: '调度测试任务',
    prompt: '执行检查',
    active: true,
    scheduleType: 'interval',
    intervalMinutes: 10,
    channelId: 'channel-1',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 1_000,
    runHistory: [],
    ...overrides,
  }
}

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))

mock.module('./agent-service', () => ({
  runAgentHeadless: async () => { /* 测试不执行真实 Agent */ },
  isAgentSessionActive: () => false,
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: () => ({ id: 'session-created' }),
  updateAgentSessionMeta: () => undefined,
  getAgentSessionMeta: () => undefined,
}))

mock.module('./agent-turn-usage-service', () => ({
  getAgentTurnUsage: async () => undefined,
}))

mock.module('./automation-notification-service', () => ({
  notifyAutomationRunFinished: async () => undefined,
}))

mock.module('./automation-manager', () => ({
  listAutomations: () => currentAutomations,
  getAutomation: (id: string) => currentAutomations.find((item) => item.id === id),
  insertAutomationRun: () => undefined,
  attachAutomationRunSession: () => undefined,
  settleAutomationRun: () => ({ applied: false }),
  recoverInterruptedAutomationRuns: () => {
    recoveredCount += 1
    return 0
  },
  updateAutomation: () => undefined,
  setNextRunAt: (id: string, nextRunAt: number) => { rescheduled.push({ id, nextRunAt }) },
  computeNextRunAt: () => 999,
}))

beforeAll(async () => {
  scheduler = await import('./automation-scheduler')
})

afterAll(() => {
  scheduler.stopScheduler()
})

describe('startScheduler 启动恢复', () => {
  test('Given 启动时存在遗留 running 记录与过期任务 When 启动调度器 Then 先恢复再顺延 nextRunAt', () => {
    currentAutomations = [createAutomation({ nextRunAt: Date.now() - 60_000 })]

    scheduler.startScheduler()
    scheduler.stopScheduler()

    expect(recoveredCount).toBe(1)
    expect(rescheduled).toEqual([{ id: 'auto-scheduler', nextRunAt: 999 }])
  })

  test('Given 调度器已启动 When 重复启动 Then 不重复执行恢复', () => {
    currentAutomations = []
    scheduler.startScheduler()
    const callsAfterFirstStart = recoveredCount
    scheduler.startScheduler()
    scheduler.stopScheduler()

    expect(callsAfterFirstStart).toBe(2)
    expect(recoveredCount).toBe(callsAfterFirstStart)
  })
})

describe('runAutomationNow 启动摘要', () => {
  test('Given 任务缺少项目 When 立即运行 Then 立即返回 started:false/not-runnable 而不是抛错', async () => {
    currentAutomations = [createAutomation({ workspaceId: undefined })]

    const result = await scheduler.runAutomationNow('auto-scheduler')

    expect(result).toMatchObject({ started: false, id: 'auto-scheduler', phase: 'not-runnable' })
    expect(result.reason).toBe('请先为该任务配置模型与项目')
  })

  test('Given 任务不存在 When 立即运行 Then 抛出明确错误', async () => {
    currentAutomations = []

    await expect(scheduler.runAutomationNow('missing')).rejects.toThrow('定时任务不存在: missing')
  })
})
