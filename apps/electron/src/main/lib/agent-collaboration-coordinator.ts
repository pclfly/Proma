/**
 * 协作 scope 协调器。
 *
 * 官方 0.22.0 用一次 scope 同时管理：
 * - 截止时间与执行轮次上限，防止自动续跑无限进行；
 * - 依赖 attempt 的不可变快照，续跑替换后可识别旧 attempt；
 * - 已投递凭据（attempt 完成、阻塞问题、deadline），避免同一结果重复回填。
 *
 * 协调器只负责状态机与通知，不直接停止子会话或写磁盘；持久化由调用方注入。
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentCollaborationAttemptSnapshot,
  AgentCollaborationScopeSnapshot,
} from '@proma/shared'

export const COLLABORATION_MAX_EXECUTIONS = 128
export const COLLABORATION_DEADLINE_MS = 2 * 60 * 60 * 1_000

export type CollaborationPersist = (snapshot: AgentCollaborationScopeSnapshot) => void

export interface CollaborationResultLike {
  delegationId: string
  attemptId?: string
  status: string
  pendingBlockedEvents?: unknown[]
}

/** 等待器：监听协作状态变化，并在超时/取消时释放。 */
export class CollaborationNotifier {
  private readonly listeners = new Set<() => void>()

  get listenerCount(): number {
    return this.listeners.size
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * 等待 check 返回非 undefined。
   * 超时返回 undefined；取消抛出 AbortError；check 抛错则原样拒绝。
   */
  wait<T>(check: () => T | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.listeners.delete(inspect)
        signal?.removeEventListener('abort', abort)
      }
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }
      const abort = () => {
        finish(() => reject(new DOMException('协作等待已取消', 'AbortError')))
      }
      const inspect = () => {
        if (settled) return
        try {
          const result = check()
          if (result !== undefined) finish(() => resolve(result))
        } catch (error) {
          finish(() => reject(error))
        }
      }

      if (signal?.aborted) {
        abort()
        return
      }
      timer = setTimeout(() => {
        finish(() => resolve(undefined))
      }, Math.max(0, timeoutMs))
      this.listeners.add(inspect)
      signal?.addEventListener('abort', abort, { once: true })
      inspect()
    })
  }
}

function createScope(): AgentCollaborationScopeSnapshot {
  return {
    scopeId: randomUUID(),
    deadline: 0,
    rounds: 0,
    dependencies: [],
    delivered: [],
    closed: false,
  }
}

/** 协作 scope 状态机；构造时从持久化快照恢复未关闭的 scope。 */
export class CollaborationCoordinator {
  readonly snapshot: AgentCollaborationScopeSnapshot
  private readonly persist: CollaborationPersist

  constructor(previous: AgentCollaborationScopeSnapshot | undefined, persist: CollaborationPersist) {
    this.persist = persist
    this.snapshot = previous && !previous.closed
      ? structuredClone(previous)
      : createScope()
  }

  /** 当前 scope 引用过的去重 delegation 列表。 */
  ids(): string[] {
    return [...new Set(this.snapshot.dependencies.map((item) => item.delegationId))]
  }

  /** 开启新的协作 scope；旧 scope 的依赖和凭据全部清空。 */
  beginScope(): void {
    Object.assign(this.snapshot, {
      scopeId: randomUUID(),
      deadline: Date.now() + COLLABORATION_DEADLINE_MS,
      rounds: 0,
      dependencies: [],
      delivered: [],
      closed: false,
      cancelled: undefined,
    })
  }

  reset(): void {
    this.beginScope()
  }

  /**
   * 启动新的 delegation 前检查取消、截止时间与轮次预算。
   * 空依赖且已过 deadline 的旧 scope 自动滚动到新 scope。
   */
  assertCanStart(count = 1): void {
    if (this.snapshot.cancelled) throw new Error('协作任务已取消')
    if (
      this.snapshot.closed
      || (this.snapshot.dependencies.length === 0 && Date.now() >= this.snapshot.deadline)
    ) {
      this.beginScope()
    }
    if (Date.now() >= this.snapshot.deadline) throw new Error('协作任务已超过截止时间')
    if (this.snapshot.rounds + count > COLLABORATION_MAX_EXECUTIONS) {
      throw new Error(`协作任务已达到轮次预算（${COLLABORATION_MAX_EXECUTIONS} 次执行）`)
    }
  }

  /** 记录一次 attempt；同一 delegation+attempt 幂等。 */
  track(
    delegationId: string,
    attemptId: string,
    attemptSnapshot?: AgentCollaborationAttemptSnapshot,
  ): void {
    if (
      !this.snapshot.closed
      && this.snapshot.dependencies.some(
        (item) => item.delegationId === delegationId && item.attemptId === attemptId,
      )
    ) return
    this.assertCanStart()
    this.snapshot.dependencies.push({ delegationId, attemptId, attemptSnapshot })
    this.snapshot.rounds += 1
    this.persist(this.snapshot)
  }

  hasReceipt(receipt: string): boolean {
    return this.snapshot.delivered.includes(receipt)
  }

  /** 只接受当前 scope 拥有的 attempt / 阻塞凭据 / deadline 凭据。 */
  acknowledge(receipts: readonly string[]): void {
    const owned = new Set(this.snapshot.dependencies.map((item) => item.attemptId))
    const accepted = receipts.filter((receipt) =>
      owned.has(receipt)
      || this.snapshot.dependencies.some((item) => receipt.startsWith(`${item.attemptId}:blocked:`))
      || receipt === `${this.snapshot.scopeId}:deadline`)
    const delivered = [...new Set([...this.snapshot.delivered, ...accepted])]
    if (delivered.length === this.snapshot.delivered.length) return
    this.snapshot.delivered = delivered
    this.persist(this.snapshot)
  }

  /** 由当前结果计算应投递的凭据；running 不产生完成凭据。 */
  receiptsFor(results: readonly CollaborationResultLike[]): string[] {
    const receipts: string[] = []
    for (const result of results) {
      const dependency = this.snapshot.dependencies.find(
        (item) => item.delegationId === result.delegationId && item.attemptId === result.attemptId,
      )
      if (!dependency) continue
      if (result.status !== 'running') receipts.push(dependency.attemptId)
      if (Array.isArray(result.pendingBlockedEvents)) {
        for (const blocker of result.pendingBlockedEvents) {
          if (!blocker || typeof blocker !== 'object') continue
          const id = (blocker as { id?: unknown }).id
          if (typeof id === 'string') receipts.push(`${dependency.attemptId}:blocked:${id}`)
        }
      }
    }
    return [...new Set(receipts)]
  }

  cancel(): void {
    this.snapshot.cancelled = true
    this.close()
  }

  close(): void {
    this.snapshot.closed = true
    this.persist(this.snapshot)
  }
}
