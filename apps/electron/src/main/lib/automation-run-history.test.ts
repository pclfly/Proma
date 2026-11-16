/**
 * 运行历史归一化 / 启动恢复的 BDD 测试（纯函数，不触碰磁盘）
 */

import { describe, expect, test } from 'bun:test'
import { AUTOMATION_MAX_HISTORY, AUTOMATION_RUN_INTERRUPTED_ERROR } from '@proma/shared'
import { markInterruptedRuns, normalizeAutomationRunHistory } from './automation-run-history'

describe('normalizeAutomationRunHistory', () => {
  test('Given v4 旧记录没有 runId When 归一化 Then 补出稳定 legacy runId 并保留原有字段', () => {
    const result = normalizeAutomationRunHistory([
      { runAt: 1_000, sessionId: 's-1', status: 'success', durationMs: 400 },
      { runAt: 2_000, sessionId: 's-2', status: 'error', error: 'boom', durationMs: 100 },
    ])

    expect(result.changed).toBe(true)
    expect(result.runHistory).toHaveLength(2)
    expect(result.runHistory[0]).toMatchObject({
      runId: 'legacy-1000-0',
      runAt: 1_000,
      sessionId: 's-1',
      status: 'success',
      durationMs: 400,
      finishedAt: 1_400,
    })
    expect(result.runHistory[1]).toMatchObject({
      runId: 'legacy-2000-1',
      status: 'error',
      error: 'boom',
      finishedAt: 2_100,
    })
  })

  test('Given 非法条目与非法状态 When 归一化 Then 丢弃坏条目并把未知状态收敛为 error', () => {
    const result = normalizeAutomationRunHistory([
      null,
      'not-a-run',
      { sessionId: 'missing-runAt' },
      { runAt: 3_000, sessionId: 's-3', status: 'exploded' },
    ])

    expect(result.changed).toBe(true)
    expect(result.runHistory).toHaveLength(1)
    expect(result.runHistory[0]).toMatchObject({
      runId: 'legacy-3000-3',
      runAt: 3_000,
      status: 'error',
      sessionId: 's-3',
    })
  })

  test('Given 上一次进程遗留的 running 记录 When 归一化 Then 保持 running 交由启动恢复处理', () => {
    const result = normalizeAutomationRunHistory([
      { runId: 'run-1', runAt: 5_000, sessionId: 's-1', status: 'running', trigger: 'schedule' },
    ])

    expect(result.changed).toBe(false)
    expect(result.runHistory[0]?.status).toBe('running')
    expect(result.runHistory[0]?.trigger).toBe('schedule')
  })

  test('Given 超过历史上限的记录 When 归一化 Then 只保留最新 AUTOMATION_MAX_HISTORY 条', () => {
    const raw = Array.from({ length: AUTOMATION_MAX_HISTORY + 5 }, (_, index) => ({
      runId: `run-${index}`,
      runAt: 10_000 - index,
      sessionId: `s-${index}`,
      status: 'success',
      durationMs: 1,
    }))

    const result = normalizeAutomationRunHistory(raw)

    expect(result.changed).toBe(true)
    expect(result.runHistory).toHaveLength(AUTOMATION_MAX_HISTORY)
    expect(result.runHistory[0]?.runId).toBe('run-0')
  })

  test('Given 非数组 / 未设置 When 归一化 Then 返回空历史且只对非 undefined 视为改动', () => {
    expect(normalizeAutomationRunHistory(undefined)).toEqual({ runHistory: [], changed: false })
    expect(normalizeAutomationRunHistory('broken')).toEqual({ runHistory: [], changed: true })
    expect(normalizeAutomationRunHistory([])).toEqual({ runHistory: [], changed: false })
  })
})

describe('markInterruptedRuns', () => {
  test('Given running 与已结算记录共存 When 启动恢复 Then 只把 running 标为中断并补结束时间', () => {
    const runs = [
      { runId: 'run-1', runAt: 1_000, sessionId: 's-1', status: 'running' as const },
      { runId: 'run-2', runAt: 2_000, sessionId: 's-2', status: 'success' as const, finishedAt: 2_500, durationMs: 500 },
    ]

    const recovered = markInterruptedRuns(runs, 9_000)

    expect(recovered).toBe(1)
    expect(runs[0]).toMatchObject({
      status: 'interrupted',
      error: AUTOMATION_RUN_INTERRUPTED_ERROR,
      finishedAt: 9_000,
      durationMs: 8_000,
    })
    expect(runs[1]).toMatchObject({ status: 'success', finishedAt: 2_500, durationMs: 500 })
  })

  test('Given 没有 running 记录 When 启动恢复 Then 不产生任何改动', () => {
    const runs = [
      { runId: 'run-1', runAt: 1_000, sessionId: 's-1', status: 'skipped' as const },
    ]

    expect(markInterruptedRuns(runs, 9_000)).toBe(0)
    expect(runs[0]?.status).toBe('skipped')
  })
})
