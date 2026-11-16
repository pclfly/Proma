/**
 * 定时任务管理器运行生命周期的 BDD 测试
 *
 * 覆盖：索引 v4→v5 迁移、启动恢复、running 落盘、按 runId 结算的幂等性、迟到回调不覆盖新一轮。
 * 使用临时 HOME + 真实 JSON 文件，不启动 Electron。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { AUTOMATION_RUN_INTERRUPTED_ERROR } from '@proma/shared'

type AutomationManager = typeof import('./automation-manager')

let manager: AutomationManager
let tempHome: string
let indexPath: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

/** 索引文件外壳（与 automations.json 结构一致） */
interface AutomationsIndexFile {
  version: number
  automations: Array<Record<string, unknown>>
}

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function readIndexFile(): AutomationsIndexFile {
  return JSON.parse(readFileSync(indexPath, 'utf-8')) as AutomationsIndexFile
}

function findAutomationRecord(id: string): Record<string, unknown> | undefined {
  return readIndexFile().automations.find((item) => item.id === id)
}

const LEGACY_AUTOMATION_ID = 'auto-legacy'

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-automation-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'

  const configDir = join(tempHome, '.proma')
  mkdirSync(configDir, { recursive: true })
  indexPath = join(configDir, 'automations.json')

  // 模拟 v4 数据：旧运行记录没有 runId，其中一条是上次进程遗留的 running；
  // 同时放入本地扩展字段（maxRuns / completedAt / permissionMode / 通知目标）验证迁移不丢字段。
  writeFileSync(indexPath, JSON.stringify({
    version: 4,
    automations: [
      {
        id: LEGACY_AUTOMATION_ID,
        name: '旧任务',
        prompt: '整理昨天的进展',
        active: true,
        scheduleType: 'interval',
        intervalMinutes: 10,
        maxRuns: 5,
        channelId: 'channel-1',
        workspaceId: 'workspace-1',
        permissionMode: 'bypassPermissions',
        sessionMode: 'daily',
        notificationTargets: [
          { type: 'feishu', enabled: true, trigger: 'always', botId: 'bot-1', chatId: 'chat-1' },
        ],
        createdAt: 1_000,
        updatedAt: 2_000,
        nextRunAt: 9_999_999_999_999,
        lastSessionId: 'session-running',
        lastRunAt: 2_000,
        runCount: 2,
        completedAt: 2_500,
        runHistory: [
          { runAt: 2_000, sessionId: 'session-running', status: 'running' },
          { runAt: 1_000, sessionId: 'session-old', status: 'success', durationMs: 400 },
        ],
      },
    ],
  }, null, 2), 'utf-8')

  manager = await import('./automation-manager')
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Automation 索引 v4 → v5 迁移', () => {
  test('Given v4 索引 When 首次加载 Then 补齐 runId 与 finishedAt 且不丢本地扩展字段', () => {
    const automation = manager.getAutomation(LEGACY_AUTOMATION_ID)

    expect(automation).toBeDefined()
    expect(automation?.runHistory).toHaveLength(2)
    expect(automation?.runHistory[0]).toMatchObject({
      runId: 'legacy-2000-0',
      status: 'running',
      sessionId: 'session-running',
    })
    expect(automation?.runHistory[1]).toMatchObject({
      runId: 'legacy-1000-1',
      status: 'success',
      finishedAt: 1_400,
    })
    // 本地扩展不能被迁移清掉
    expect(automation).toMatchObject({
      maxRuns: 5,
      completedAt: 2_500,
      permissionMode: 'bypassPermissions',
      sessionMode: 'daily',
      runCount: 2,
      notificationTargets: [
        { type: 'feishu', enabled: true, trigger: 'always', botId: 'bot-1', chatId: 'chat-1' },
      ],
    })

    const disk = readIndexFile()
    expect(disk.version).toBe(5)
    const record = findAutomationRecord(LEGACY_AUTOMATION_ID)
    expect(record).toBeDefined()
  })
})

describe('启动恢复', () => {
  test('Given 上次进程遗留 running 记录 When 启动恢复 Then 标为中断且不推进调度、不重复计数', () => {
    const before = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(before?.runCount).toBe(2)
    expect(before?.nextRunAt).toBe(9_999_999_999_999)

    const recovered = manager.recoverInterruptedAutomationRuns()

    expect(recovered).toBe(1)
    const after = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(after?.runHistory[0]).toMatchObject({
      status: 'interrupted',
      error: AUTOMATION_RUN_INTERRUPTED_ERROR,
    })
    expect(typeof after?.runHistory[0]?.finishedAt).toBe('number')
    // 恢复不是一次真实执行：不推进 nextRunAt、不增加 runCount、不改变启用状态
    expect(after?.nextRunAt).toBe(9_999_999_999_999)
    expect(after?.runCount).toBe(2)
    expect(after?.active).toBe(true)

    const onDisk = findAutomationRecord(LEGACY_AUTOMATION_ID) as { runHistory: Array<{ status: string }> }
    expect(onDisk.runHistory[0]?.status).toBe('interrupted')
  })

  test('Given 已没有 running 记录 When 再次启动恢复 Then 返回 0 且保持原状', () => {
    expect(manager.recoverInterruptedAutomationRuns()).toBe(0)
  })
})

describe('运行记录生命周期', () => {
  const runId = 'run-live-1'
  const runAt = 10_000

  test('Given 一轮运行开始 When 写入 running 记录 Then 磁盘立即可见且会话 ID 可后补', () => {
    const updated = manager.insertAutomationRun(LEGACY_AUTOMATION_ID, {
      runId,
      runAt,
      sessionId: '',
      status: 'running',
      trigger: 'manual',
    })

    expect(updated?.runHistory[0]).toMatchObject({ runId, status: 'running', sessionId: '' })
    const onDisk = findAutomationRecord(LEGACY_AUTOMATION_ID) as { runHistory: Array<{ runId: string; status: string }> }
    expect(onDisk.runHistory[0]).toMatchObject({ runId, status: 'running' })

    manager.attachAutomationRunSession(LEGACY_AUTOMATION_ID, runId, 'session-live-1')
    const withSession = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(withSession?.runHistory[0]?.sessionId).toBe('session-live-1')
    expect(withSession?.lastSessionId).toBe('session-live-1')
  })

  test('Given running 记录 When 成功结算 Then 同一 runId 合并为一条且只计数一次', () => {
    const historyLengthBefore = manager.getAutomation(LEGACY_AUTOMATION_ID)?.runHistory.length ?? 0

    const result = manager.settleAutomationRun(LEGACY_AUTOMATION_ID, runId, {
      status: 'success',
      sessionId: 'session-live-1',
      finishedAt: 11_500,
      durationMs: 1_500,
    })

    expect(result.applied).toBe(true)
    const automation = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(automation?.runHistory).toHaveLength(historyLengthBefore)
    expect(automation?.runHistory[0]).toMatchObject({
      runId,
      status: 'success',
      finishedAt: 11_500,
      durationMs: 1_500,
    })
    expect(automation?.runCount).toBe(3)
    expect(automation?.lastRunAt).toBe(runAt)
    expect(automation?.consecutiveFailures).toBe(0)
  })

  test('Given 同一 runId 的迟到回调 When 再次结算 Then 判定为已结算且不重复计数', () => {
    const runCountBefore = manager.getAutomation(LEGACY_AUTOMATION_ID)?.runCount

    const result = manager.settleAutomationRun(LEGACY_AUTOMATION_ID, runId, {
      status: 'error',
      error: '迟到的失败回调',
    })

    expect(result.applied).toBe(false)
    expect(result.reason).toBe('already-settled')
    expect(manager.getAutomation(LEGACY_AUTOMATION_ID)?.runCount).toBe(runCountBefore)
    expect(manager.getAutomation(LEGACY_AUTOMATION_ID)?.runHistory[0]?.status).toBe('success')
  })

  test('Given 新一轮已开始 When 上一轮的迟到回调到达 Then 不覆盖新一轮记录', () => {
    manager.insertAutomationRun(LEGACY_AUTOMATION_ID, {
      runId: 'run-live-2',
      runAt: 12_000,
      sessionId: 'session-live-2',
      status: 'running',
      trigger: 'schedule',
    })

    manager.settleAutomationRun(LEGACY_AUTOMATION_ID, runId, {
      status: 'error',
      error: '上一轮迟到的超时回调',
    })

    const automation = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(automation?.runHistory[0]).toMatchObject({ runId: 'run-live-2', status: 'running' })
    expect(automation?.runHistory[1]).toMatchObject({ runId, status: 'success' })
    expect(automation?.runCount).toBe(3) // 上一轮已结算过一次，迟到回调不再计数
  })

  test('Given 重入跳过 When 写入 skipped 记录 Then 不推进调度、不计入 runCount', () => {
    const before = manager.getAutomation(LEGACY_AUTOMATION_ID)
    const nextRunAtBefore = before?.nextRunAt
    const runCountBefore = before?.runCount

    manager.insertAutomationRun(LEGACY_AUTOMATION_ID, {
      runId: 'run-skipped',
      runAt: 13_000,
      sessionId: '',
      status: 'skipped',
      finishedAt: 13_000,
      durationMs: 0,
      skipReason: '上一轮尚未结束',
      trigger: 'schedule',
    })

    const after = manager.getAutomation(LEGACY_AUTOMATION_ID)
    expect(after?.runHistory[0]).toMatchObject({ runId: 'run-skipped', status: 'skipped' })
    expect(after?.runCount).toBe(runCountBefore)
    expect(after?.nextRunAt).toBe(nextRunAtBefore)
  })

  test('Given 不存在的任务 When 写入或结算 Then 安全返回空结果', () => {
    expect(manager.insertAutomationRun('missing', {
      runId: 'run-x',
      runAt: 1,
      sessionId: '',
      status: 'running',
    })).toBeUndefined()

    const result = manager.settleAutomationRun('missing', 'run-x', { status: 'success' })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('automation-missing')
  })
})
