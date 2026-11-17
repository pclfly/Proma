/**
 * 工作区文件搜索服务（带缓存的异步索引）
 *
 * 每个根目录维护一份 `{ entries, scannedAt, truncated }` 索引：
 * - 首次查询时异步构建，之后命中索引，避免每次按键都全量扫盘
 * - TTL（默认 60s）+ 脏标记：目录观察器通知变更后只重建对应根
 * - 同一根的并发查询共享同一个 in-flight Promise
 * - 条目只保存相对路径，查询时再投影出 source（session/workspace）与绝对/相对路径
 */

import { resolve } from 'node:path'
import type { FileIndexEntry, FileSearchResult } from '@proma/shared'
import {
  projectAttachedEntries,
  projectDirectoryEntries,
  rankMatchedEntries,
  sortBrowseEntries,
} from './workspace-file-search-ranking'
import { scanDirectoryRoot } from './workspace-file-search-scan'
import type { RootScan, RootScanner, WorkspaceFileSearchLimits } from './workspace-file-search-scan'

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_ENTRIES_PER_ROOT = 20_000
const DEFAULT_MAX_ROOTS = 32
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 1000

/** 空查询浏览模式的分组与总量上限，沿用旧实现 */
const BROWSE_LIMIT_PER_GROUP = 2000
const BROWSE_TOTAL_CAP = 3000

export interface WorkspaceFileSearchInput {
  rootPath: string
  query: string
  limit?: number
  additionalPaths?: string[]
  sessionPaths?: string[]
}

/** 与现有 FileSearchResult 兼容，额外标注索引构建时间与截断状态 */
export interface WorkspaceFileSearchResponse extends FileSearchResult {
  /** 参与本次结果的最旧索引构建时间（ms） */
  scannedAt: number
  /** 是否有根索引因深度/条目上限被截断 */
  truncated: boolean
}

export interface WorkspaceFileSearchServiceOptions {
  ttlMs?: number
  maxDepth?: number
  maxEntriesPerRoot?: number
  maxRoots?: number
  now?: () => number
  /** 仅用于测试：替换扫描实现，便于统计扫描次数与控制时序 */
  scanner?: RootScanner
}

export interface WorkspaceFileSearchService {
  search(input: WorkspaceFileSearchInput): Promise<WorkspaceFileSearchResponse>
  /** 标记单个根索引过期，下次查询时重建 */
  invalidate(root: string): void
  /** 批量标记：变更路径落在根内（或根本身位于变更路径下）时失效对应根 */
  invalidatePaths(paths: readonly string[]): void
  /** 丢弃根索引，会话/工作区删除后调用 */
  forget(root: string): void
  /** 释放全部索引缓存；后续查询会重新构建 */
  dispose(): void
  indexedRootCount(): number
}

interface RootIndexState {
  root: string
  scan: RootScan | null
  /** 每次 invalidate 递增；构建完成版本不一致时下次查询会重建 */
  version: number
  builtVersion: number
  inFlight: Promise<RootScan> | null
  lastAccessAt: number
}

function normalizeForCompare(filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForCompare(root)
  const normalizedCandidate = normalizeForCompare(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function uniqueResolved(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (!path) continue
    const absolutePath = resolve(path)
    const key = normalizeForCompare(absolutePath)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(absolutePath)
  }
  return result
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT)
}

function buildResponse(
  entries: FileIndexEntry[],
  total: number,
  sessionEntries: FileIndexEntry[],
  workspaceEntries: FileIndexEntry[],
  scans: readonly RootScan[],
): WorkspaceFileSearchResponse {
  let scannedAt = Number.POSITIVE_INFINITY
  let truncated = false
  for (const scan of scans) {
    scannedAt = Math.min(scannedAt, scan.scannedAt)
    if (scan.truncated) truncated = true
  }
  return {
    entries,
    total,
    sessionEntries,
    workspaceEntries,
    scannedAt: Number.isFinite(scannedAt) ? scannedAt : Date.now(),
    truncated,
  }
}

export function createWorkspaceFileSearchService(
  options: WorkspaceFileSearchServiceOptions = {},
): WorkspaceFileSearchService {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxRoots = options.maxRoots ?? DEFAULT_MAX_ROOTS
  const now = options.now ?? (() => Date.now())
  const scanner: RootScanner = options.scanner ?? scanDirectoryRoot
  const limits: WorkspaceFileSearchLimits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntriesPerRoot: options.maxEntriesPerRoot ?? DEFAULT_MAX_ENTRIES_PER_ROOT,
  }

  const states = new Map<string, RootIndexState>()

  function ensureState(root: string): RootIndexState {
    const existing = states.get(root)
    if (existing) return existing
    if (states.size >= maxRoots) {
      let oldestRoot: string | null = null
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [candidate, state] of states) {
        if (state.lastAccessAt < oldestAccess) {
          oldestAccess = state.lastAccessAt
          oldestRoot = candidate
        }
      }
      if (oldestRoot !== null) states.delete(oldestRoot)
    }
    const state: RootIndexState = {
      root,
      scan: null,
      version: 0,
      builtVersion: -1,
      inFlight: null,
      lastAccessAt: now(),
    }
    states.set(root, state)
    return state
  }

  function getScan(root: string): Promise<RootScan> {
    const state = ensureState(root)
    const currentTime = now()
    state.lastAccessAt = currentTime

    if (state.scan && state.builtVersion === state.version && currentTime - state.scan.scannedAt < ttlMs) {
      return Promise.resolve(state.scan)
    }
    // 同一根的并发查询共享构建过程
    if (state.inFlight) return state.inFlight

    const version = state.version
    const promise = scanner(root, limits).then(
      (scan) => {
        state.scan = scan
        state.builtVersion = version
        state.inFlight = null
        return scan
      },
      (error: unknown) => {
        state.inFlight = null
        throw error
      },
    )
    state.inFlight = promise
    return promise
  }

  async function getScanSafe(root: string): Promise<RootScan> {
    try {
      return await getScan(root)
    } catch (error) {
      console.warn('[文件索引] 扫描失败，本次按空索引处理:', root, error)
      return { root, kind: 'missing', entries: [], scannedAt: now(), truncated: false }
    }
  }

  function invalidate(root: string): void {
    const state = states.get(resolve(root))
    if (state) state.version += 1
  }

  function invalidatePaths(paths: readonly string[]): void {
    if (paths.length === 0) return
    const changedPaths = paths.map((path) => resolve(path))
    for (const state of states.values()) {
      if (changedPaths.some((changedPath) => isPathInside(state.root, changedPath))) {
        state.version += 1
      }
    }
  }

  function forget(root: string): void {
    states.delete(resolve(root))
  }

  function dispose(): void {
    states.clear()
  }

  async function search(input: WorkspaceFileSearchInput): Promise<WorkspaceFileSearchResponse> {
    const limit = normalizeLimit(input.limit)
    const query = input.query.trim().toLowerCase()
    const rootPath = input.rootPath ? resolve(input.rootPath) : ''
    if (!rootPath) {
      return buildResponse([], 0, [], [], [])
    }

    const sessionPaths = uniqueResolved(input.sessionPaths)
    const additionalPaths = uniqueResolved(input.additionalPaths)

    const [rootScan, sessionScans, workspaceScans] = await Promise.all([
      getScanSafe(rootPath),
      Promise.all(sessionPaths.map((path) => getScanSafe(path))),
      Promise.all(additionalPaths.map((path) => getScanSafe(path))),
    ])

    const sessionEntries: FileIndexEntry[] = projectDirectoryEntries(rootScan, 'relative', 'session')
    const workspaceEntries: FileIndexEntry[] = []
    sessionPaths.forEach((_path, index) => {
      const scan = sessionScans[index]
      if (scan) sessionEntries.push(...projectAttachedEntries(scan, 'session'))
    })
    additionalPaths.forEach((_path, index) => {
      const scan = workspaceScans[index]
      if (scan) workspaceEntries.push(...projectAttachedEntries(scan, 'workspace'))
    })

    const scans = [rootScan, ...sessionScans, ...workspaceScans]

    if (!query) {
      // 空查询：目录优先排序后再截断，保证文件夹结构完整可见
      const sessionSorted = sortBrowseEntries(sessionEntries)
      const workspaceSorted = sortBrowseEntries(workspaceEntries)
      const maxPerGroup = Math.max(limit, BROWSE_LIMIT_PER_GROUP)
      const sessionSlice = sessionSorted.slice(0, maxPerGroup)
      const workspaceSlice = workspaceSorted.slice(0, maxPerGroup)
      const combinedSorted = sortBrowseEntries([...sessionSlice, ...workspaceSlice])
      const combined = combinedSorted.length > BROWSE_TOTAL_CAP
        ? combinedSorted.slice(0, BROWSE_TOTAL_CAP)
        : combinedSorted
      return buildResponse(
        combined,
        sessionEntries.length + workspaceEntries.length,
        sessionSlice,
        workspaceSlice,
        scans,
      )
    }

    const sessionMatched = rankMatchedEntries(sessionEntries, query)
    const workspaceMatched = rankMatchedEntries(workspaceEntries, query)
    const totalMatched = sessionMatched.length + workspaceMatched.length

    let sessionSlice: FileIndexEntry[]
    let workspaceSlice: FileIndexEntry[]
    if (totalMatched <= limit) {
      sessionSlice = sessionMatched
      workspaceSlice = workspaceMatched
    } else {
      const sessionQuota = Math.max(
        sessionMatched.length > 0 ? 1 : 0,
        Math.round((limit * sessionMatched.length) / totalMatched),
      )
      const workspaceQuota = Math.max(workspaceMatched.length > 0 ? 1 : 0, limit - sessionQuota)
      sessionSlice = sessionMatched.slice(0, sessionQuota)
      workspaceSlice = workspaceMatched.slice(0, workspaceQuota)
    }

    const combined = rankMatchedEntries([...sessionSlice, ...workspaceSlice], query)
    return buildResponse(combined, totalMatched, sessionSlice, workspaceSlice, scans)
  }

  return {
    search,
    invalidate,
    invalidatePaths,
    forget,
    dispose,
    indexedRootCount: () => states.size,
  }
}

const defaultService = createWorkspaceFileSearchService()

export function searchWorkspaceFilesIndexed(
  input: WorkspaceFileSearchInput,
): Promise<WorkspaceFileSearchResponse> {
  return defaultService.search(input)
}

/** 目录观察器通知变更后调用：只失效包含该路径的根索引 */
export function invalidateWorkspaceFileIndexForPaths(paths: readonly string[]): void {
  defaultService.invalidatePaths(paths)
}

export function forgetWorkspaceFileIndex(root: string): void {
  defaultService.forget(root)
}

/** 应用退出时释放索引缓存 */
export function disposeWorkspaceFileSearch(): void {
  defaultService.dispose()
}