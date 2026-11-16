/**
 * 变更请求轮询器
 *
 * 按 PR 链接维护订阅关系（一条链接可被多个会话共享），并在到期时读取状态。
 *
 * 关键语义：
 * - **in-flight 合并**：同一链接同时只允许一个请求；手动刷新复用进行中的请求，
 *   既不重复请求，也不排在后台轮询后面串行等待。
 * - **退避**：失败按 active * 2^(n-1) 退避到 maxBackoff；已合并的 PR 停止轮询；
 *   已关闭的 PR 降到慢速；检查项未完成或 mergeable 未知时用 active 节奏。
 * - **dispose**：退出与测试中清理全部定时器与订阅。
 */

import type { ChangeRequestSnapshot } from '@proma/shared'
import { isChangeRequestCheckPending } from '@proma/shared'

/** 单条链接的读取结果；错误不抛出，交给调用方决定如何展示。 */
export type ChangeRequestPollResult =
  | { snapshot: ChangeRequestSnapshot }
  | { error: string }

export interface ChangeRequestPollTimers {
  now: () => number
  setTimeout: (handler: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface ChangeRequestPollIntervals {
  /** 检查项进行中/合并状态未知时的节奏 */
  activeMs: number
  /** 一切稳定时的节奏 */
  idleMs: number
  /** 已关闭 PR 的节奏 */
  closedMs: number
  maxBackoffMs: number
  maxConcurrent: number
}

/** 一次同步输入的会话绑定。 */
export interface ChangeRequestPollSession {
  sessionId: string
  urls: readonly string[]
}

export interface ChangeRequestPollerOptions {
  /** 读取单条 PR 状态；不得抛出（抛出的异常会被归一成 error 结果）。 */
  fetch: (url: string) => Promise<ChangeRequestPollResult>
  /** 结果落库，返回受影响的会话 id。 */
  settle: (url: string, result: ChangeRequestPollResult) => string[]
  /** 状态变化后推送给渲染层。 */
  notify?: (sessionIds: string[]) => void
  intervals?: Partial<ChangeRequestPollIntervals>
  timers?: Partial<ChangeRequestPollTimers>
  /** 已关闭 PR 的保留时长；超过后停止轮询。 */
  closedRetentionMs?: number
}

export const DEFAULT_CHANGE_REQUEST_POLL_INTERVALS: ChangeRequestPollIntervals = {
  activeMs: 30_000,
  idleMs: 120_000,
  closedMs: 300_000,
  maxBackoffMs: 900_000,
  maxConcurrent: 3,
}

/** 已关闭 PR 的轮询保留时长：7 天。 */
export const DEFAULT_CLOSED_POLL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const defaultTimers: ChangeRequestPollTimers = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 计算下一次轮询间隔；undefined 表示不再轮询。
 *
 * 导出以便单测直接验证退避策略，而不依赖真实定时器。
 */
export function nextChangeRequestPollDelay(
  result: ChangeRequestPollResult,
  failures: number,
  intervals: ChangeRequestPollIntervals,
  closedForMs = 0,
  closedRetentionMs = DEFAULT_CLOSED_POLL_RETENTION_MS,
): number | undefined {
  if (closedForMs >= closedRetentionMs) return undefined
  if ('error' in result) {
    return Math.min(intervals.maxBackoffMs, intervals.activeMs * 2 ** Math.max(0, failures - 1))
  }
  if (result.snapshot.state === 'MERGED') return undefined
  if (result.snapshot.state === 'CLOSED') return intervals.closedMs
  const unstable = (result.snapshot.mergeable || '').toUpperCase() === 'UNKNOWN'
    || result.snapshot.checks.some(isChangeRequestCheckPending)
  return unstable ? intervals.activeMs : intervals.idleMs
}

interface ChangeRequestWatch {
  url: string
  sessions: Set<string>
  dueAt?: number
  failures: number
  closedSince?: number
}

export class ChangeRequestPoller {
  private readonly options: ChangeRequestPollerOptions
  private readonly intervals: ChangeRequestPollIntervals
  private readonly timers: ChangeRequestPollTimers
  private readonly closedRetentionMs: number
  private readonly watches = new Map<string, ChangeRequestWatch>()
  private readonly inFlight = new Map<string, Promise<ChangeRequestPollResult>>()
  private timer: unknown
  private disposed = false

  constructor(options: ChangeRequestPollerOptions) {
    this.options = options
    this.intervals = { ...DEFAULT_CHANGE_REQUEST_POLL_INTERVALS, ...options.intervals }
    this.timers = { ...defaultTimers, ...options.timers }
    this.closedRetentionMs = options.closedRetentionMs ?? DEFAULT_CLOSED_POLL_RETENTION_MS
  }

  /** 用最新的会话绑定整体替换成员关系；不再被引用的链接立即取消订阅。 */
  sync(sessions: readonly ChangeRequestPollSession[]): void {
    if (this.disposed) return

    const next = new Map<string, Set<string>>()
    for (const session of sessions) {
      for (const url of session.urls) {
        const owners = next.get(url) ?? new Set<string>()
        owners.add(session.sessionId)
        next.set(url, owners)
      }
    }

    for (const [url, watch] of [...this.watches]) {
      const owners = next.get(url)
      if (!owners || owners.size === 0) {
        this.watches.delete(url)
        continue
      }
      watch.sessions = new Set(owners)
    }

    for (const [url, owners] of next) {
      if (this.watches.has(url)) continue
      this.watches.set(url, {
        url,
        sessions: new Set(owners),
        dueAt: this.timers.now(),
        failures: 0,
      })
    }

    this.schedule()
  }

  /** 移除某个会话的成员关系；没有成员后链接不再轮询。 */
  removeSession(sessionId: string): void {
    if (this.disposed) return
    for (const [url, watch] of [...this.watches]) {
      watch.sessions.delete(sessionId)
      if (watch.sessions.size === 0) this.watches.delete(url)
    }
    this.schedule()
  }

  /**
   * 立即刷新某个会话（可选单条链接），返回共享的 in-flight 结果。
   *
   * 手动刷新不看并发上限、不排队；若该链接已有请求在飞，直接复用同一个 promise。
   */
  async refreshSession(sessionId: string, url?: string): Promise<ChangeRequestPollResult[]> {
    if (this.disposed) return []
    const targets = [...this.watches.values()]
      .filter((watch) => watch.sessions.has(sessionId) && (!url || watch.url === url))
    if (url && targets.length === 0) {
      return [{ error: '该变更请求未关联或已隐藏，请重新关联后刷新。' }]
    }
    return Promise.all(targets.map((watch) => this.ensureFetch(watch)))
  }

  /** 立即刷新单条链接（不关心会话），主要供绑定后主动取一次状态。 */
  async refreshUrl(url: string): Promise<ChangeRequestPollResult[]> {
    if (this.disposed) return []
    const watch = this.watches.get(url)
    if (!watch) return []
    return [await this.ensureFetch(watch)]
  }

  /** 执行所有已到期的后台查询，返回本轮发起的链接。 */
  async pollDue(): Promise<string[]> {
    if (this.disposed) return []
    const now = this.timers.now()
    const due = [...this.watches.values()]
      .filter((watch) => !this.inFlight.has(watch.url) && watch.dueAt !== undefined && watch.dueAt <= now)
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))

    const capacity = Math.max(0, this.intervals.maxConcurrent - this.inFlight.size)
    const batch = due.slice(0, capacity)
    if (batch.length === 0) {
      this.schedule()
      return []
    }

    await Promise.all(batch.map((watch) => this.ensureFetch(watch)))
    this.schedule()
    return batch.map((watch) => watch.url)
  }

  /** 当前订阅的链接，供自检与测试使用。 */
  watchedUrls(): string[] {
    return [...this.watches.keys()]
  }

  /** 链接是否已有请求在飞。 */
  isInFlight(url: string): boolean {
    return this.inFlight.has(url)
  }

  /** 距下次轮询的毫秒数；未注册或已停止时为 undefined。 */
  delayOf(url: string): number | undefined {
    const watch = this.watches.get(url)
    if (!watch || watch.dueAt === undefined) return undefined
    return Math.max(0, watch.dueAt - this.timers.now())
  }

  /** 停止轮询并清空订阅；应用退出与会话级测试使用。 */
  dispose(): void {
    this.disposed = true
    this.watches.clear()
    this.inFlight.clear()
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private ensureFetch(watch: ChangeRequestWatch): Promise<ChangeRequestPollResult> {
    const existing = this.inFlight.get(watch.url)
    if (existing) return existing

    watch.dueAt = undefined
    const promise = this.runFetch(watch)
    this.inFlight.set(watch.url, promise)
    void promise.then(() => {
      if (this.inFlight.get(watch.url) === promise) this.inFlight.delete(watch.url)
      this.schedule()
    })
    return promise
  }

  private async runFetch(watch: ChangeRequestWatch): Promise<ChangeRequestPollResult> {
    let result: ChangeRequestPollResult
    try {
      result = await this.options.fetch(watch.url)
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) }
    }

    // 已停止或订阅已被替换：结果仍返回给等待者，但不再写盘或推送。
    if (this.disposed || this.watches.get(watch.url) !== watch) return result

    let affected: string[] = []
    try {
      affected = this.options.settle(watch.url, result)
    } catch (error) {
      console.warn('[变更请求] 写入轮询结果失败:', error)
      affected = []
      result = { error: '无法保存变更请求状态，请检查本地会话文件。' }
    }

    const now = this.timers.now()
    if ('error' in result) {
      watch.failures += 1
    } else {
      watch.failures = 0
    }
    if ('snapshot' in result && result.snapshot.state === 'CLOSED') {
      watch.closedSince ??= now
    } else if (!('error' in result)) {
      watch.closedSince = undefined
    }
    const closedForMs = watch.closedSince === undefined ? 0 : Math.max(0, now - watch.closedSince)
    const interval = nextChangeRequestPollDelay(result, watch.failures, this.intervals, closedForMs, this.closedRetentionMs)
    if (interval === undefined) {
      this.watches.delete(watch.url)
    } else {
      watch.dueAt = now + interval
    }

    if (affected.length > 0 && this.options.notify) {
      try {
        this.options.notify([...new Set(affected)])
      } catch (error) {
        console.warn('[变更请求] 推送状态失败:', error)
      }
    }

    return result
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.disposed || this.inFlight.size >= this.intervals.maxConcurrent) return

    let next: number | undefined
    for (const watch of this.watches.values()) {
      if (watch.dueAt === undefined || this.inFlight.has(watch.url)) continue
      next = next === undefined ? watch.dueAt : Math.min(next, watch.dueAt)
    }
    if (next === undefined) return

    const delay = Math.max(0, next - this.timers.now())
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.pollDue()
    }, delay)
  }
}
