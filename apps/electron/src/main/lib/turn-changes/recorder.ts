/**
 * TurnChangeRecorder — 每轮 Agent 文件改动记录器。
 *
 * 生命周期：
 * 1. beginTurn：建立该轮基线表，并在后台探测 Git 仓库状态（尽最大努力）；
 * 2. noteToolTargets：写工具执行前登记目标并捕获基线；工具执行后再登记一次，
 *    用于覆盖跳过权限回调的工具，缺失基线时尝试从 Git HEAD 恢复；
 * 3. finishTurn：轮次结束（完成/停止/失败）统一结算，产出 TurnChangesSnapshot，
 *    按 sessionId+turnId 有界缓存并追加到每会话 JSONL。
 *
 * 结算幂等：同一轮重复调用返回同一快照。轮次记录失败只告警，不得影响
 * Agent 主流程；所有读写都是只读文件/Git 读取 + Proma 配置目录原子写。
 */

import { join } from 'node:path'
import type {
  TurnChangeEntry,
  TurnChangeOutcome,
  TurnChangesSnapshot,
} from '@proma/shared'
import {
  TURN_CHANGES_MAX_FILE_BYTES,
  TURN_CHANGES_MAX_FILES,
  TURN_CHANGES_MAX_TOTAL_BYTES,
} from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { type ActiveTurn, turnKey } from './active-turn'
import { captureAfterBaseline, captureBeforeBaseline } from './baseline'
import { captureFileSnapshot } from './capture'
import { compareSnapshots, summarizeEntries } from './compare'
import { GitReader } from './git'
import { normalizePathKey, relativeToRoot, resolveTargetPath } from './paths'
import { TurnChangesStore } from './store'
import { resolveToolTargets } from './targets'
import type {
  BeginTurnInput,
  FinishTurnInput,
  NoteToolTargetsInput,
  TurnChangeLimits,
  TurnChangeRecorderOptions,
  TurnChangeSettledListener,
} from './types'

const SNAPSHOT_VERSION = 1 as const
const DEFAULT_MAX_TURNS_PER_SESSION = 100
const DEFAULT_MAX_SESSIONS = 50
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_PRUNE_INTERVAL_MS = 10 * 60 * 1000

export class TurnChangeRecorder {
  private readonly clock: () => number
  private readonly captureFile: NonNullable<TurnChangeRecorderOptions['captureFile']>
  private readonly createGitReader: NonNullable<TurnChangeRecorderOptions['createGitReader']>
  private readonly limits: Required<TurnChangeLimits>
  private readonly maxTurnsPerSession: number
  private readonly maxSessions: number
  private readonly retentionMs: number
  private readonly pruneIntervalMs: number
  private readonly store: TurnChangesStore

  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly settled = new Map<string, TurnChangesSnapshot>()
  private readonly settling = new Map<string, Promise<TurnChangesSnapshot | undefined>>()
  private readonly snapshots = new Map<string, TurnChangesSnapshot[]>()
  private readonly loadedSessions = new Set<string>()
  private readonly lastAccess = new Map<string, number>()
  private readonly generations = new Map<string, number>()
  private readonly listeners = new Set<TurnChangeSettledListener>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: TurnChangeRecorderOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
    this.captureFile = options.captureFile ?? captureFileSnapshot
    this.createGitReader = options.createGitReader ?? ((rootPath) => new GitReader(rootPath))
    this.limits = {
      maxFileBytes: options.limits?.maxFileBytes ?? TURN_CHANGES_MAX_FILE_BYTES,
      maxFiles: options.limits?.maxFiles ?? TURN_CHANGES_MAX_FILES,
      maxTotalBytes: options.limits?.maxTotalBytes ?? TURN_CHANGES_MAX_TOTAL_BYTES,
    }
    this.maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS
    this.store = new TurnChangesStore({
      rootDir: options.storageDir ?? join(getConfigDir(), 'turn-changes'),
      maxTurnsPerSession: this.maxTurnsPerSession,
    })
    if (options.pruneTimer !== false) {
      this.pruneTimer = setInterval(() => this.prune(), this.pruneIntervalMs)
      this.pruneTimer.unref?.()
    }
  }

  /** 轮次开始：建立空基线表并异步探测 Git，不阻塞 Agent 主流程。 */
  beginTurn(input: BeginTurnInput): void {
    const key = turnKey(input.sessionId, input.turnId)
    if (this.activeTurns.has(key)) return
    const gitReader = this.createGitReader(input.rootPath)
    const active: ActiveTurn = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      rootPath: input.rootPath,
      startedAt: input.startedAt ?? this.clock(),
      generation: this.generations.get(input.sessionId) ?? 0,
      baselines: new Map(),
      order: [],
      usedBytes: 0,
      droppedFiles: 0,
      gitReader,
    }
    if (gitReader) active.gitSnapshot = gitReader.getSnapshot().catch(() => null)
    this.activeTurns.set(key, active)
    this.lastAccess.set(input.sessionId, this.clock())
  }

  /** 登记写工具目标；首个登记点负责捕获该文件在本轮内的基线。 */
  async noteToolTargets(input: NoteToolTargetsInput): Promise<void> {
    const active = this.activeTurns.get(turnKey(input.sessionId, input.turnId))
    if (!active) return
    for (const target of resolveToolTargets(input.toolName, input.input)) {
      const absolutePath = resolveTargetPath(active.rootPath, target)
      const filePath = relativeToRoot(active.rootPath, absolutePath)
      // 越界目标不进入记录，避免把会话外文件带进预览与持久化。
      if (!filePath) continue
      const pathKey = normalizePathKey(absolutePath)
      if (active.baselines.has(pathKey)) continue
      if (active.baselines.size >= this.limits.maxFiles) {
        active.droppedFiles += 1
        continue
      }
      const baseline = input.phase === 'after'
        ? await captureAfterBaseline(absolutePath, filePath, {
            limits: this.limits,
            usedBytes: active.usedBytes,
            captureFile: this.captureFile,
            clock: this.clock,
            gitReader: active.gitReader,
            gitSnapshot: active.gitSnapshot,
            turnStartedAt: active.startedAt,
          })
        : captureBeforeBaseline(absolutePath, filePath, {
            limits: this.limits,
            usedBytes: active.usedBytes,
            captureFile: this.captureFile,
            clock: this.clock,
          })
      if (!baseline) {
        active.droppedFiles += 1
        continue
      }
      active.baselines.set(pathKey, baseline)
      active.order.push(pathKey)
      active.usedBytes += baseline.before.text ? Buffer.byteLength(baseline.before.text, 'utf8') : 0
    }
  }

  /** 结算轮次；停止、失败同样结算，重复调用返回同一快照。 */
  async finishTurn(input: FinishTurnInput): Promise<TurnChangesSnapshot | undefined> {
    const key = turnKey(input.sessionId, input.turnId)
    const settled = this.settled.get(key)
    if (settled) return settled
    const inflight = this.settling.get(key)
    if (inflight) return inflight
    const active = this.activeTurns.get(key)
    if (!active) return undefined
    this.activeTurns.delete(key)
    const task = this.settle(active, input.status, input.finishedAt ?? this.clock())
      .finally(() => this.settling.delete(key))
    this.settling.set(key, task)
    return task
  }

  /** 读取会话的轮次记录（时间升序）；内存为空时从 JSONL 恢复。 */
  getTurns(sessionId: string, limit?: number): TurnChangesSnapshot[] {
    this.loadPersisted(sessionId)
    const turns = [...(this.snapshots.get(sessionId) ?? [])].sort((left, right) => left.startedAt - right.startedAt)
    this.lastAccess.set(sessionId, this.clock())
    if (limit !== undefined && limit > 0) return turns.slice(-limit)
    return turns
  }

  onSettled(listener: TurnChangeSettledListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 会话删除：丢弃内存与磁盘记录，并让迟到的结算不再写回。 */
  clearSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    for (const key of [...this.activeTurns.keys()]) {
      if (this.activeTurns.get(key)?.sessionId === sessionId) this.activeTurns.delete(key)
    }
    for (const key of [...this.settled.keys()]) {
      if (this.settled.get(key)?.sessionId === sessionId) this.settled.delete(key)
    }
    this.snapshots.delete(sessionId)
    this.loadedSessions.delete(sessionId)
    this.lastAccess.delete(sessionId)
    try {
      this.store.clear(sessionId)
    } catch (error) {
      console.warn('[TurnChanges] 清理会话记录失败:', error)
    }
  }

  /** 应用退出：停止定时器并释放内存缓存。 */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.activeTurns.clear()
    this.settled.clear()
    this.settling.clear()
    this.snapshots.clear()
    this.loadedSessions.clear()
    this.lastAccess.clear()
    this.listeners.clear()
  }

  /** 周期性清理超过保留期的内存会话（磁盘 JSONL 保留）。 */
  prune(): void {
    const now = this.clock()
    for (const [sessionId, accessedAt] of [...this.lastAccess]) {
      if (now - accessedAt <= this.retentionMs) continue
      this.forgetSession(sessionId)
    }
    if (this.snapshots.size <= this.maxSessions) return
    const ordered = [...this.lastAccess.entries()].sort((left, right) => left[1] - right[1])
    for (const [sessionId] of ordered) {
      if (this.snapshots.size <= this.maxSessions) break
      this.forgetSession(sessionId)
    }
  }

  private forgetSession(sessionId: string): void {
    this.snapshots.delete(sessionId)
    this.loadedSessions.delete(sessionId)
    this.lastAccess.delete(sessionId)
    for (const key of [...this.settled.keys()]) {
      if (this.settled.get(key)?.sessionId === sessionId) this.settled.delete(key)
    }
  }

  private async settle(
    active: ActiveTurn,
    status: TurnChangeOutcome,
    finishedAt: number,
  ): Promise<TurnChangesSnapshot | undefined> {
    const entries: TurnChangeEntry[] = []
    for (const key of active.order) {
      const baseline = active.baselines.get(key)
      if (!baseline) continue
      const remainingBytes = Math.max(0, this.limits.maxTotalBytes - active.usedBytes)
      const after = this.captureFile(baseline.absolutePath, {
        maxFileBytes: this.limits.maxFileBytes,
        remainingBytes,
      })
      const entry = compareSnapshots({
        rootPath: active.rootPath,
        filePath: baseline.filePath,
        before: baseline.before,
        after,
        changedAt: finishedAt,
        baselineSource: baseline.baselineSource,
      })
      if (entry) entries.push(entry)
    }

    const snapshot: TurnChangesSnapshot = {
      version: SNAPSHOT_VERSION,
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
      startedAt: active.startedAt,
      finishedAt,
      rootPath: active.rootPath,
      entries,
      ...summarizeEntries(entries),
      ...(active.droppedFiles > 0 ? { droppedFiles: active.droppedFiles } : {}),
    }

    // 会话在结算期间被删除时，不写回缓存或磁盘。
    if ((this.generations.get(active.sessionId) ?? 0) !== active.generation) return undefined
    this.remember(snapshot)
    this.persist(snapshot)
    this.notify(snapshot)
    return snapshot
  }

  private remember(snapshot: TurnChangesSnapshot): void {
    const existing = this.snapshots.get(snapshot.sessionId) ?? []
    const merged = existing
      .filter((turn) => turn.turnId !== snapshot.turnId)
      .concat(snapshot)
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-this.maxTurnsPerSession)
    this.snapshots.set(snapshot.sessionId, merged)
    this.loadedSessions.add(snapshot.sessionId)
    this.settled.set(turnKey(snapshot.sessionId, snapshot.turnId), snapshot)
    this.lastAccess.set(snapshot.sessionId, this.clock())
    if (this.snapshots.size > this.maxSessions) this.prune()
  }

  private notify(snapshot: TurnChangesSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('[TurnChanges] 推送轮次改动失败:', error)
      }
    }
  }

  private persist(snapshot: TurnChangesSnapshot): void {
    try {
      this.store.write(snapshot)
    } catch (error) {
      console.warn('[TurnChanges] 持久化轮次改动失败:', error)
    }
  }

  private loadPersisted(sessionId: string): void {
    if (this.loadedSessions.has(sessionId)) return
    this.loadedSessions.add(sessionId)
    const persisted = this.store.read(sessionId)
    if (persisted.length === 0) return
    const merged = new Map<string, TurnChangesSnapshot>()
    for (const turn of persisted) merged.set(turn.turnId, turn)
    for (const turn of this.snapshots.get(sessionId) ?? []) merged.set(turn.turnId, turn)
    this.snapshots.set(
      sessionId,
      [...merged.values()]
        .sort((left, right) => left.startedAt - right.startedAt)
        .slice(-this.maxTurnsPerSession),
    )
  }
}

let defaultRecorder: TurnChangeRecorder | null = null

/** 主进程单例；测试应直接 new TurnChangeRecorder 注入临时目录。 */
export function getTurnChangeRecorder(): TurnChangeRecorder {
  defaultRecorder ??= new TurnChangeRecorder()
  return defaultRecorder
}
