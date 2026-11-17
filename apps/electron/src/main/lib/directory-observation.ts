/**
 * 通用目录观察器
 *
 * 在 Node `fs.watch` 之上提供统一语义，供工作区监听与文件索引共用：
 * - Windows/macOS 使用递归监听；其他平台逐目录监听（根目录立即建立，子目录异步补齐）
 * - 原生事件按根合并、去重后批量回调，避免高频文件操作直接打到上层
 * - 单个根监听失败只让该根不可用，不抛异常；根目录被删除时通过 `rootUnavailable` 通知
 * - 事件回调里不做同步重活：只登记脏根/脏路径，flush 时才做一次存在性检查
 */

import { existsSync, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isHighNoisePath, normalizeWatchFilename } from './workspace-watcher-utils'

/** 默认 debounce：落在 150–300ms 区间，兼顾批量合并与响应速度 */
const DEFAULT_DEBOUNCE_MS = 200
const MAX_DEBOUNCE_MS = 5000
/** 逐目录回退时最多监听多少个目录，避免在超大树形上失控 */
const DEFAULT_MAX_OBSERVED_DIRECTORIES = 512

/** 观察器实际使用的监听模式 */
export type DirectoryObservationMode = 'recursive' | 'per-directory'

/** `auto` 按平台选择：Windows/macOS 递归，其余平台逐目录 */
export type DirectoryObservationStrategy = 'auto' | DirectoryObservationMode

/** 最小可注入 watcher 契约，使测试可以替换 fs.watch */
export interface DirectoryWatcherHandle {
  on(event: 'change', listener: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void): void
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void
  close(): void
}

export type DirectoryWatchFactory = (path: string, options: { recursive: boolean }) => DirectoryWatcherHandle

export interface DirectoryObservationChange {
  /** 触发变化的根目录（绝对路径） */
  root: string
  /** 去重后的绝对路径；为空表示根目录发生未知变化 */
  paths: string[]
  /** 根目录已删除或不可访问，调用方应释放该根缓存并重新注册 */
  rootUnavailable: boolean
}

export interface DirectoryObservationOptions {
  roots: readonly string[]
  onChange: (change: DirectoryObservationChange) => void
  /** 批量合并窗口，默认 200ms，上限 5000ms */
  debounceMs?: number
  /** 相对根目录的路径是否忽略，默认复用工作区高频噪声目录规则 */
  ignore?: (relativePath: string) => boolean
  strategy?: DirectoryObservationStrategy
  /** 仅用于测试：覆盖平台判定 */
  platform?: NodeJS.Platform
  /** 仅用于测试：替换 fs.watch */
  watchFactory?: DirectoryWatchFactory
  maxObservedDirectories?: number
}

export interface DirectoryObservation {
  /** 是否已建立至少一个根监听；false 时调用方应回退旧实现 */
  readonly available: boolean
  /** 选定或已生效的监听模式 */
  readonly mode: DirectoryObservationMode
  isObserving(root: string): boolean
  /** 增量替换根集合：新增根建立监听，移除的根关闭监听 */
  setRoots(roots: readonly string[]): void
  dispose(): void
}

interface RootRuntime {
  root: string
  handles: DirectoryWatcherHandle[]
  /** 逐目录模式下已监听的目录数量 */
  observedDirectories: number
  disposed: boolean
}

interface PendingRootChange {
  paths: Set<string>
  unknown: boolean
  unavailable: boolean
}

const nodeWatchFactory: DirectoryWatchFactory = (path, options) => watch(path, options)

function resolveMode(strategy: DirectoryObservationStrategy, platform: NodeJS.Platform): DirectoryObservationMode {
  if (strategy !== 'auto') return strategy
  return platform === 'win32' || platform === 'darwin' ? 'recursive' : 'per-directory'
}

function clampDebounce(debounceMs: number | undefined): number {
  if (debounceMs === undefined || !Number.isFinite(debounceMs)) return DEFAULT_DEBOUNCE_MS
  return Math.min(Math.max(debounceMs, 0), MAX_DEBOUNCE_MS)
}

/** 相对路径转成 `/` 分隔；越界或空路径返回 null */
function toRelativePath(relativePath: string): string | null {
  if (!relativePath) return null
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized === '.' || normalized.startsWith('../')) return null
  return normalized
}

export function createDirectoryObservation(options: DirectoryObservationOptions): DirectoryObservation {
  const ignore = options.ignore ?? isHighNoisePath
  const factory = options.watchFactory ?? nodeWatchFactory
  const debounceMs = clampDebounce(options.debounceMs)
  const maxDirectories = options.maxObservedDirectories ?? DEFAULT_MAX_OBSERVED_DIRECTORIES
  const mode = resolveMode(options.strategy ?? 'auto', options.platform ?? process.platform)

  const runtimes = new Map<string, RootRuntime>()
  const pending = new Map<string, PendingRootChange>()
  /** 已经通知过 rootUnavailable 的根，避免重复回调 */
  const notifiedUnavailable = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function emit(change: DirectoryObservationChange): void {
    try {
      options.onChange(change)
    } catch (error) {
      console.error('[目录观察] onChange 回调异常:', change.root, error)
    }
  }

  function scheduleFlush(): void {
    if (disposed || flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, debounceMs)
    // 索引/监听清理不应被该定时器拖住进程退出
    flushTimer.unref?.()
  }

  function pendingFor(root: string): PendingRootChange {
    let entry = pending.get(root)
    if (!entry) {
      entry = { paths: new Set(), unknown: false, unavailable: false }
      pending.set(root, entry)
    }
    return entry
  }

  function notePath(root: string, absolutePath: string): void {
    pendingFor(root).paths.add(absolutePath)
    scheduleFlush()
  }

  function noteUnknown(root: string): void {
    pendingFor(root).unknown = true
    scheduleFlush()
  }

  function noteUnavailable(root: string): void {
    pendingFor(root).unavailable = true
    scheduleFlush()
  }

  function releaseRoot(root: string): void {
    const runtime = runtimes.get(root)
    pending.delete(root)
    if (!runtime) return
    runtime.disposed = true
    runtimes.delete(root)
    for (const handle of runtime.handles) {
      try { handle.close() } catch { /* watcher 可能已自行关闭 */ }
    }
    runtime.handles.length = 0
  }

  function flush(): void {
    if (disposed || pending.size === 0) return
    const batch = [...pending.entries()]
    pending.clear()

    for (const [root, entry] of batch) {
      if (disposed) return
      const runtime = runtimes.get(root)
      // 根目录被删除/权限变化后不会再产生可靠事件，只通知一次并释放句柄。
      if (entry.unavailable || !existsSync(root)) {
        if (runtime) releaseRoot(root)
        if (!notifiedUnavailable.has(root)) {
          notifiedUnavailable.add(root)
          emit({ root, paths: [], rootUnavailable: true })
        }
        continue
      }
      if (!entry.unknown && entry.paths.size === 0) continue
      emit({ root, paths: [...entry.paths], rootUnavailable: false })
    }
  }

  function attachWatcher(runtime: RootRuntime, watchDir: string, baseDir: string): boolean {
    let handle: DirectoryWatcherHandle
    try {
      handle = factory(watchDir, { recursive: mode === 'recursive' })
    } catch (error) {
      console.warn('[目录观察] 建立监听失败:', watchDir, error)
      return false
    }

    runtime.handles.push(handle)
    runtime.observedDirectories += 1

    handle.on('change', (_eventType, filename) => {
      if (disposed || runtime.disposed) return
      const normalized = normalizeWatchFilename(filename)
      if (!normalized) {
        // 没拿到文件名时保守标脏整根，避免漏掉索引失效。
        noteUnknown(runtime.root)
        return
      }
      if (ignore(normalized)) return
      notePath(runtime.root, resolve(baseDir, normalized))
    })

    handle.on('error', (error) => {
      if (disposed || runtime.disposed) return
      console.warn('[目录观察] 监听出错:', runtime.root, error)
      noteUnavailable(runtime.root)
    })

    return true
  }

  /** 逐目录模式：根目录已同步监听，子目录异步补齐，避免同步读取大目录 */
  async function walkSubdirectories(runtime: RootRuntime): Promise<void> {
    const queue: string[] = [runtime.root]

    while (queue.length > 0) {
      if (disposed || runtime.disposed) return
      if (runtime.observedDirectories >= maxDirectories) return
      const dir = queue.shift()
      if (!dir) return

      let dirents
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue
        const childDir = join(dir, dirent.name)
        const relativePath = toRelativePath(relative(runtime.root, childDir))
        if (relativePath === null || ignore(relativePath)) continue
        if (runtime.observedDirectories >= maxDirectories) return
        if (!attachWatcher(runtime, childDir, childDir)) continue
        queue.push(childDir)
      }
    }
  }

  function startRoot(rawRoot: string): void {
    if (disposed) return
    const root = resolve(rawRoot)
    if (runtimes.has(root)) return
    if (!existsSync(root)) return
    notifiedUnavailable.delete(root)

    const runtime: RootRuntime = {
      root,
      handles: [],
      observedDirectories: 0,
      disposed: false,
    }

    if (!attachWatcher(runtime, root, root)) return
    if (mode === 'per-directory') void walkSubdirectories(runtime)

    runtimes.set(root, runtime)
  }

  function setRoots(roots: readonly string[]): void {
    if (disposed) return
    const nextRoots = new Set(roots.map((root) => resolve(root)))
    for (const root of [...runtimes.keys()]) {
      if (!nextRoots.has(root)) releaseRoot(root)
    }
    for (const root of nextRoots) startRoot(root)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    pending.clear()
    for (const root of [...runtimes.keys()]) releaseRoot(root)
    runtimes.clear()
    notifiedUnavailable.clear()
  }

  setRoots(options.roots)

  return {
    get available(): boolean {
      return runtimes.size > 0
    },
    mode,
    isObserving(root: string): boolean {
      return runtimes.has(resolve(root))
    },
    setRoots,
    dispose,
  }
}