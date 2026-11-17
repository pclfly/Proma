/**
 * 工作区文件监听器
 *
 * 监听 ~/.proma/agent-workspaces/ 与附加目录，根据变化的文件路径区分事件类型：
 * - mcp.json / skills/ / skills-inactive/ 变化 → 推送 CAPABILITIES_CHANGED（侧边栏刷新）
 * - 其他文件变化 → 推送 WORKSPACE_FILES_CHANGED（文件浏览器刷新，并失效文件索引）
 *
 * 事件来源优先使用 directory-observation（原生 fs.watch 批量事件 + 合并去重）；
 * 观察器不可用时回退到逐根 fs.watch 的旧实现。两条路径共享同一套分类与 debounce 语义。
 */

import { existsSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { getAgentWorkspacesDir } from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import { invalidateGitDiffCache } from './git-diff-service'
import { createDirectoryObservation } from './directory-observation'
import type { DirectoryObservation, DirectoryObservationChange } from './directory-observation'
import { invalidateWorkspaceFileIndexForPaths } from './workspace-file-search'
import { createMissingRootWatchers } from './workspace-watcher-missing-roots'
import {
  WORKSPACE_WATCH_DEBOUNCE_MS,
  notifyCapabilitiesChanged,
  notifyWorkspaceFilesChanged,
  resetWorkspaceWatcherNotifications,
  setWorkspaceWatcherWindow,
} from './workspace-watcher-notify'
import { classifyWorkspaceWatchFilename, normalizeWatchFilename, shouldNotifyForWatchFilename } from './workspace-watcher-utils'

/** watcher 'error' 事件后的自愈重启延迟（ms），避免对持续故障状态紧密重试 */
const WATCHER_RESTART_DELAY_MS = 5000

/** 主监听或父目录监听的延迟重启定时器，停止时统一清理。 */
const watcherRestartTimers = new Set<ReturnType<typeof setTimeout>>()
let workspaceWatcherActive = false

/** 原生目录观察器（首选）；不可用时为 null，走旧 fs.watch 实现 */
let observation: DirectoryObservation | null = null
/** 交给观察器监听的附加根目录 */
const observedAttachedRoots = new Set<string>()
/** 旧实现的附加目录监听器：路径 → FSWatcher */
const attachedWatchers = new Map<string, FSWatcher>()
/** 旧实现的主工作区监听器 */
let legacyWorkspaceWatcher: FSWatcher | null = null

function scheduleWatcherRestart(callback: () => void): void {
  const timer = setTimeout(() => {
    watcherRestartTimers.delete(timer)
    if (workspaceWatcherActive) callback()
  }, WATCHER_RESTART_DELAY_MS)
  watcherRestartTimers.add(timer)
}

function isExistingDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false
  try {
    return statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

/** 相对路径统一成 `/` 分隔；越界或自身返回 null */
function normalizeObservedRelativePath(relativePath: string): string | null {
  if (!relativePath) return null
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized === '.' || normalized.startsWith('../')) return null
  return normalized
}

const missingRootWatchers = createMissingRootWatchers({
  isExistingDirectory,
  notifyFilesChanged: () => notifyWorkspaceFilesChanged(),
  scheduleRestart: scheduleWatcherRestart,
  watchDirectory: (dirPath) => watchAttachedDirectory(dirPath),
})

function observationRoots(watchDir: string): string[] {
  const roots = [watchDir]
  for (const root of observedAttachedRoots) {
    if (isExistingDirectory(root)) roots.push(root)
  }
  return roots
}

function syncObservationRoots(): void {
  observation?.setRoots(observationRoots(getAgentWorkspacesDir()))
}

function disposeObservation(): void {
  if (!observation) return
  observation.dispose()
  observation = null
}

/**
 * 启动工作区文件监听
 *
 * @param win 主窗口引用，用于向渲染进程推送事件
 */
export function startWorkspaceWatcher(win: BrowserWindow): void {
  workspaceWatcherActive = true
  setWorkspaceWatcherWindow(win)
  const watchDir = getAgentWorkspacesDir()

  // 观察器优先：批量合并后的脏路径通知；建立失败时回退旧实现。
  startObservation(win, watchDir)

  // 会话附加目录只需在启动/监听器重启时恢复一次；LIST_SESSIONS 是高频读取路径，
  // 不能随每次列表 IPC 再遍历全部会话并触发同步 stat。
  restoreAgentSessionAttachedDirectoryWatchers()

  if (!existsSync(watchDir)) {
    console.warn('[工作区监听] 目录不存在，跳过:', watchDir)
    return
  }
  if (!observation) startLegacyWorkspaceWatcher(win, watchDir)
}

function startObservation(win: BrowserWindow, watchDir: string): void {
  disposeObservation()
  if (!existsSync(watchDir)) return

  const created = createDirectoryObservation({
    roots: observationRoots(watchDir),
    debounceMs: WORKSPACE_WATCH_DEBOUNCE_MS,
    ignore: (relativePath) => !shouldNotifyForWatchFilename(relativePath),
    onChange: (change) => handleObservedChange(win, change),
  })

  if (!created.available) {
    created.dispose()
    console.warn('[工作区监听] 原生目录观察不可用，回退 fs.watch 实现')
    return
  }

  observation = created
  console.log('[工作区监听] 已启动文件监听:', watchDir)
}

function handleObservedChange(win: BrowserWindow, change: DirectoryObservationChange): void {
  const watchDir = getAgentWorkspacesDir()
  const isWorkspaceRoot = resolve(change.root) === resolve(watchDir)

  if (change.rootUnavailable) {
    invalidateWorkspaceFileIndexForPaths([change.root])
    if (isWorkspaceRoot) {
      console.warn('[工作区监听] 工作区根目录不可用，等待重建:', change.root)
      disposeObservation()
      scheduleWatcherRestart(() => {
        if (workspaceWatcherActive && !win.isDestroyed() && !observation) {
          startWorkspaceWatcher(win)
        }
      })
      return
    }
    // 附加目录失效：切回父目录监听，等目录恢复后重新挂载观察器。
    console.warn('[附加目录监听] 目录不可用，切换为父目录监听:', change.root)
    observedAttachedRoots.delete(change.root)
    syncObservationRoots()
    missingRootWatchers.watch(change.root)
    return
  }

  if (change.paths.length > 0) invalidateWorkspaceFileIndexForPaths(change.paths)

  if (isWorkspaceRoot) {
    for (const absolutePath of change.paths) {
      const relativePath = normalizeObservedRelativePath(relative(watchDir, absolutePath))
      if (relativePath === null) continue
      // 普通文件及有限的 Diff 状态元数据变更均需失效缓存；fetch 的高噪声 Git 元数据仍被忽略。
      if (shouldNotifyForWatchFilename(relativePath)) invalidateGitDiffCache(absolutePath)
      const changeType = classifyWorkspaceWatchFilename(relativePath)
      if (!changeType) continue
      if (changeType === 'capabilities') notifyCapabilitiesChanged(win)
      else notifyWorkspaceFilesChanged(absolutePath)
    }
    return
  }

  for (const absolutePath of change.paths) {
    const relativePath = normalizeObservedRelativePath(relative(change.root, absolutePath))
    if (relativePath !== null && shouldNotifyForWatchFilename(relativePath)) {
      invalidateGitDiffCache(absolutePath)
    }
  }
  notifyWorkspaceFilesChanged(change.paths)
}

function startLegacyWorkspaceWatcher(win: BrowserWindow, watchDir: string): void {
  try {
    legacyWorkspaceWatcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || win.isDestroyed()) return

      // filename 格式: {slug}/mcp.json 或 {slug}/skills/xxx/SKILL.md 或 {slug}/{sessionId}/file.txt
      const normalizedFilename = normalizeWatchFilename(filename)
      if (normalizedFilename === null) return

      if (shouldNotifyForWatchFilename(normalizedFilename)) {
        invalidateGitDiffCache(join(watchDir, normalizedFilename))
      }
      invalidateWorkspaceFileIndexForPaths([join(watchDir, normalizedFilename)])
      const changeType = classifyWorkspaceWatchFilename(normalizedFilename)
      if (!changeType) return

      if (changeType === 'capabilities') {
        notifyCapabilitiesChanged(win)
        return
      }
      // 保留删除与目录路径，renderer 会在记录会话文件改动前确认路径仍是实际文件。
      notifyWorkspaceFilesChanged(join(watchDir, normalizedFilename))
    })

    // EventEmitter 在 'error' 事件无监听器时会抛出未捕获异常并终止 Electron 主进程，
    // 当目录被删除/权限变更/iCloud 同步异常等运行时错误发生时即触发。必须显式监听并降级。
    legacyWorkspaceWatcher.on('error', (err) => {
      console.error('[工作区监听] 运行时错误，将尝试自愈重启:', err)
      try { legacyWorkspaceWatcher?.close() } catch { /* watcher 可能已自动关闭 */ }
      legacyWorkspaceWatcher = null
      scheduleWatcherRestart(() => {
        if (!win.isDestroyed() && !legacyWorkspaceWatcher) startWorkspaceWatcher(win)
      })
    })

    console.log('[工作区监听] 已启动文件监听:', watchDir)
  } catch (error) {
    console.error('[工作区监听] 启动失败:', error)
  }
}

/**
 * 停止工作区文件监听
 */
export function stopWorkspaceWatcher(): void {
  workspaceWatcherActive = false
  for (const timer of watcherRestartTimers) clearTimeout(timer)
  watcherRestartTimers.clear()

  disposeObservation()
  observedAttachedRoots.clear()

  if (legacyWorkspaceWatcher) {
    try { legacyWorkspaceWatcher.close() } catch { /* watcher 可能已自动关闭 */ }
    legacyWorkspaceWatcher = null
    console.log('[工作区监听] 已停止')
  }
  // 同时清理所有附加目录及其缺失路径父目录监听器。
  for (const [dirPath, watcher] of attachedWatchers) {
    try { watcher.close() } catch { /* watcher 可能已自动关闭 */ }
    console.log('[附加目录监听] 已停止:', dirPath)
  }
  attachedWatchers.clear()
  missingRootWatchers.dispose()

  resetWorkspaceWatcherNotifications()
}

/**
 * 开始监听附加目录
 * 当目录内文件变化时，推送 WORKSPACE_FILES_CHANGED 事件
 */
export function watchAttachedDirectory(dirPath: string): void {
  if (!isExistingDirectory(dirPath)) {
    // 本地项目根一开始不存在时不能直接 fs.watch；监听最近存在父目录即可在其恢复时
    // 触发一次 renderer 状态刷新。多个同父路径的根共享一个 watcher。
    if (observation) {
      observedAttachedRoots.delete(dirPath)
      syncObservationRoots()
    }
    missingRootWatchers.watch(dirPath)
    return
  }

  missingRootWatchers.release(dirPath)

  if (observation) {
    if (!observedAttachedRoots.has(dirPath)) {
      observedAttachedRoots.add(dirPath)
      syncObservationRoots()
    }
    if (observation.isObserving(dirPath)) return
    // 观察器没能接管该根（权限/平台限制）时退回逐根 fs.watch
    observedAttachedRoots.delete(dirPath)
    syncObservationRoots()
  }

  if (attachedWatchers.has(dirPath)) return

  try {
    const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
      const normalizedFilename = normalizeWatchFilename(filename)
      if (normalizedFilename === null || !shouldNotifyForWatchFilename(normalizedFilename)) return
      const changedPath = join(dirPath, normalizedFilename)
      invalidateGitDiffCache(changedPath)
      invalidateWorkspaceFileIndexForPaths([changedPath])
      notifyWorkspaceFilesChanged(changedPath)
    })

    // 同主 watcher：监听 'error' 防止运行时异常拖死主进程。
    // 附加目录通常是用户外接的项目目录，断电/挂载/权限变化更易触发。
    watcher.on('error', (err) => {
      console.error('[附加目录监听] 运行时错误，切换为父目录监听:', dirPath, err)
      try { watcher.close() } catch { /* 已关闭 */ }
      if (attachedWatchers.get(dirPath) === watcher) attachedWatchers.delete(dirPath)
      missingRootWatchers.watch(dirPath)
    })

    attachedWatchers.set(dirPath, watcher)
    console.log('[附加目录监听] 已启动:', dirPath)
  } catch (error) {
    console.error('[附加目录监听] 启动失败，切换为父目录监听:', dirPath, error)
    missingRootWatchers.watch(dirPath)
  }
}

/**
 * 停止监听附加目录
 */
export function unwatchAttachedDirectory(dirPath: string): void {
  observedAttachedRoots.delete(dirPath)
  syncObservationRoots()

  const watcher = attachedWatchers.get(dirPath)
  if (watcher) {
    try { watcher.close() } catch { /* watcher 可能已自动关闭 */ }
    attachedWatchers.delete(dirPath)
    console.log('[附加目录监听] 已停止:', dirPath)
  }
  missingRootWatchers.release(dirPath)
}

function restoreAgentSessionAttachedDirectoryWatchers(): void {
  for (const session of listAgentSessions()) {
    for (const dirPath of session.attachedDirectories ?? []) {
      watchAttachedDirectory(dirPath)
    }
    for (const filePath of session.attachedFiles ?? []) {
      watchAttachedDirectory(dirname(filePath))
    }
  }
}