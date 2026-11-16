/**
 * 变更请求轮询器测试
 *
 * 覆盖：in-flight 合并、手动刷新不排队、失败退避、合并后停止、会话移除、dispose 与并发上限。
 */

import { describe, expect, test } from 'bun:test'
import type { ChangeRequestSnapshot } from '@proma/shared'
import {
  ChangeRequestPoller,
  DEFAULT_CHANGE_REQUEST_POLL_INTERVALS,
  nextChangeRequestPollDelay,
  type ChangeRequestPollResult,
  type ChangeRequestPollTimers,
} from './change-request-poller'

const URL_A = 'https://github.com/acme/repo/pull/1'
const URL_B = 'https://github.com/acme/repo/pull/2'

function snapshot(overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    title: '示例 PR',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature/login',
    baseRefName: 'main',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    checks: [],
    fetchedAt: 1,
    ...overrides,
  }
}

function createFakeTimers(): {
  timers: ChangeRequestPollTimers
  advance: (ms: number) => void
  pendingCount: () => number
} {
  let now = 0
  let nextId = 1
  const queue = new Map<number, { at: number; handler: () => void }>()

  return {
    timers: {
      now: () => now,
      setTimeout: (handler: () => void, delayMs: number) => {
        const id = nextId++
        queue.set(id, { at: now + delayMs, handler })
        return id
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === 'number') queue.delete(handle)
      },
    },
    advance: (ms: number) => {
      now += ms
      for (const [id, entry] of [...queue]) {
        if (entry.at > now) continue
        queue.delete(id)
        entry.handler()
      }
    },
    pendingCount: () => queue.size,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface FetchHarness {
  calls: string[]
  fetch: (url: string) => Promise<ChangeRequestPollResult>
  resolveWith: (result: ChangeRequestPollResult) => void
  setResult: (result: ChangeRequestPollResult) => void
}

function createFetchHarness(): FetchHarness {
  const calls: string[] = []
  let pending: Array<(result: ChangeRequestPollResult) => void> = []
  let preset: ChangeRequestPollResult | null = null

  return {
    calls,
    fetch: (url: string) => {
      calls.push(url)
      if (preset) return Promise.resolve(preset)
      return new Promise<ChangeRequestPollResult>((resolve) => {
        pending.push(resolve)
      })
    },
    resolveWith: (result: ChangeRequestPollResult) => {
      const listeners = pending
      pending = []
      for (const resolve of listeners) resolve(result)
    },
    setResult: (result: ChangeRequestPollResult) => {
      preset = result
    },
  }
}

describe('nextChangeRequestPollDelay', () => {
  test('Given 读取失败，When 失败次数递增，Then 按 active 指数退避并封顶', () => {
    const intervals = DEFAULT_CHANGE_REQUEST_POLL_INTERVALS
    expect(nextChangeRequestPollDelay({ error: 'x' }, 1, intervals)).toBe(intervals.activeMs)
    expect(nextChangeRequestPollDelay({ error: 'x' }, 2, intervals)).toBe(intervals.activeMs * 2)
    expect(nextChangeRequestPollDelay({ error: 'x' }, 10, intervals)).toBe(intervals.maxBackoffMs)
  })

  test('Given 已合并，When 计算间隔，Then 不再轮询', () => {
    const result: ChangeRequestPollResult = { snapshot: snapshot({ state: 'MERGED' }) }
    expect(nextChangeRequestPollDelay(result, 0, DEFAULT_CHANGE_REQUEST_POLL_INTERVALS)).toBeUndefined()
  })

  test('Given 检查项未完成，When 计算间隔，Then 使用 active 节奏', () => {
    const result: ChangeRequestPollResult = {
      snapshot: snapshot({ checks: [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }] }),
    }
    expect(nextChangeRequestPollDelay(result, 0, DEFAULT_CHANGE_REQUEST_POLL_INTERVALS))
      .toBe(DEFAULT_CHANGE_REQUEST_POLL_INTERVALS.activeMs)
  })

  test('Given 状态稳定，When 计算间隔，Then 使用 idle 节奏', () => {
    const result: ChangeRequestPollResult = { snapshot: snapshot() }
    expect(nextChangeRequestPollDelay(result, 0, DEFAULT_CHANGE_REQUEST_POLL_INTERVALS))
      .toBe(DEFAULT_CHANGE_REQUEST_POLL_INTERVALS.idleMs)
  })
})

describe('ChangeRequestPoller', () => {
  test('Given 同一 PR 被两个会话共享，When 同时手动刷新，Then 只发一次请求', async () => {
    const harness = createFetchHarness()
    const poller = new ChangeRequestPoller({ fetch: harness.fetch, settle: () => [] })
    poller.sync([
      { sessionId: 'session-a', urls: [URL_A] },
      { sessionId: 'session-b', urls: [URL_A] },
    ])

    const first = poller.refreshSession('session-a')
    const second = poller.refreshSession('session-b')
    expect(harness.calls).toEqual([URL_A])

    harness.resolveWith({ snapshot: snapshot() })
    const [firstResult] = await first
    const [secondResult] = await second
    expect(firstResult).toEqual(secondResult)
    expect(harness.calls).toHaveLength(1)
    poller.dispose()
  })

  test('Given 后台轮询正在读取同一 PR，When 用户手动刷新，Then 复用同一个 in-flight 请求而不排队', async () => {
    const harness = createFetchHarness()
    const fake = createFakeTimers()
    const poller = new ChangeRequestPoller({
      fetch: harness.fetch,
      settle: () => ['session-a'],
      timers: fake.timers,
    })
    poller.sync([{ sessionId: 'session-a', urls: [URL_A] }])

    const background = poller.pollDue()
    expect(poller.isInFlight(URL_A)).toBe(true)

    const manual = poller.refreshSession('session-a')
    expect(harness.calls).toEqual([URL_A])

    harness.resolveWith({ snapshot: snapshot() })
    await background
    const results = await manual

    expect(results).toHaveLength(1)
    expect('snapshot' in results[0]!).toBe(true)
    expect(harness.calls).toHaveLength(1)
    poller.dispose()
  })

  test('Given 读取失败，When 依次刷新，Then 到期时间按退避延长', async () => {
    const fake = createFakeTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ error: '网络错误' }),
      settle: () => [],
      timers: fake.timers,
    })
    poller.sync([{ sessionId: 'session-a', urls: [URL_A] }])

    await poller.refreshSession('session-a')
    expect(poller.delayOf(URL_A)).toBe(DEFAULT_CHANGE_REQUEST_POLL_INTERVALS.activeMs)

    fake.advance(DEFAULT_CHANGE_REQUEST_POLL_INTERVALS.activeMs)
    await poller.refreshSession('session-a')
    expect(poller.delayOf(URL_A)).toBe(DEFAULT_CHANGE_REQUEST_POLL_INTERVALS.activeMs * 2)

    poller.dispose()
  })

  test('Given PR 已合并，When 读取完成，Then 停止轮询该链接', async () => {
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot({ state: 'MERGED' }) }),
      settle: () => [],
    })
    poller.sync([{ sessionId: 'session-a', urls: [URL_A] }])

    await poller.refreshSession('session-a')

    expect(poller.watchedUrls()).toEqual([])
    expect(poller.delayOf(URL_A)).toBeUndefined()
    poller.dispose()
  })

  test('Given 结果已写入，When 读取完成，Then 通知受影响会话（去重）', async () => {
    const notified: string[][] = []
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => ['session-a', 'session-a', 'session-b'],
      notify: (sessionIds) => notified.push(sessionIds),
    })
    poller.sync([
      { sessionId: 'session-a', urls: [URL_A] },
      { sessionId: 'session-b', urls: [URL_A] },
    ])

    await poller.refreshSession('session-a')

    expect(notified).toEqual([['session-a', 'session-b']])
    poller.dispose()
  })

  test('Given 会话被删除，When 移除订阅，Then 不再为它发起请求', async () => {
    const harness = createFetchHarness()
    const poller = new ChangeRequestPoller({ fetch: harness.fetch, settle: () => [] })
    poller.sync([{ sessionId: 'session-a', urls: [URL_A] }])

    poller.removeSession('session-a')
    const results = await poller.refreshSession('session-a')

    expect(results).toEqual([])
    expect(harness.calls).toEqual([])
    expect(poller.watchedUrls()).toEqual([])
    poller.dispose()
  })

  test('Given 多个链接同时到期，When 后台轮询，Then 受并发上限约束', async () => {
    const harness = createFetchHarness()
    const poller = new ChangeRequestPoller({
      fetch: harness.fetch,
      settle: () => [],
      intervals: { maxConcurrent: 2 },
    })
    poller.sync([{
      sessionId: 'session-a',
      urls: [URL_A, URL_B, 'https://github.com/acme/repo/pull/3'],
    }])

    const firstBatch = poller.pollDue()
    expect(harness.calls).toHaveLength(2)
    expect(poller.watchedUrls()).toHaveLength(3)

    harness.resolveWith({ snapshot: snapshot() })
    expect(await firstBatch).toHaveLength(2)
    expect(poller.isInFlight(URL_A)).toBe(false)
    poller.dispose()
  })

  test('Given 轮询器已 dispose，When 再次刷新，Then 立即返回且清理定时器', async () => {
    const fake = createFakeTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => [],
      timers: fake.timers,
    })
    poller.sync([{ sessionId: 'session-a', urls: [URL_A] }])
    await poller.refreshSession('session-a')
    expect(fake.pendingCount()).toBeGreaterThan(0)

    poller.dispose()

    expect(fake.pendingCount()).toBe(0)
    expect(await poller.refreshSession('session-a')).toEqual([])
    expect(poller.watchedUrls()).toEqual([])
  })
})
