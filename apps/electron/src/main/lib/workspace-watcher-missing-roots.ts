/**
 * 缺失附加目录的父目录监听
 *
 * 附加目录一开始不存在（例如本地项目尚未创建）时无法直接 fs.watch，
 * 改为监听最近的已存在父目录，在目标恢复时通知渲染进程重新读取状态。
 * 多个同父路径的根共享同一个父目录 watcher，避免监听器数量爆炸。
 */

import { watch as watchDirectory } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isHighNoisePath, normalizeWatchFilename } from './workspace-watcher-utils'

export interface MissingRootWatcherDeps {
  isExistingDirectory: (dirPath: string) => boolean
  notifyFilesChanged: () => void
  scheduleRestart: (callback: () => void) => void
  /** 目标目录恢复后重新建立监听 */
  watchDirectory: (dirPath: string) => void
}

export interface MissingRootWatchers {
  watch(dirPath: string): void
  release(dirPath: string): void
  dispose(): void
}

interface ParentDirectoryWatcher {
  watcher: FSWatcher
  targetPaths: Set<string>
}

export function createMissingRootWatchers(deps: MissingRootWatcherDeps): MissingRootWatchers {
  const parentWatchers = new Map<string, ParentDirectoryWatcher>()
  /** 缺失/失效的目标目录 → 正在监听的最近存在父目录 */
  const unavailableParents = new Map<string, string>()

  function findNearestExistingDirectory(dirPath: string): string | null {
    let candidate = dirPath
    while (true) {
      if (deps.isExistingDirectory(candidate)) return candidate
      const parent = dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }

  function release(dirPath: string): void {
    const parentPath = unavailableParents.get(dirPath)
    if (!parentPath) return

    unavailableParents.delete(dirPath)
    const entry = parentWatchers.get(parentPath)
    if (!entry) return

    entry.targetPaths.delete(dirPath)
    if (entry.targetPaths.size > 0) return

    try { entry.watcher.close() } catch { /* watcher 可能已自动关闭 */ }
    parentWatchers.delete(parentPath)
    console.log('[附加目录监听] 已停止父目录监听:', parentPath)
  }

  function watch(dirPath: string): void {
    const parentPath = findNearestExistingDirectory(dirname(dirPath))
    if (!parentPath) {
      console.warn('[附加目录监听] 找不到可监听的父目录:', dirPath)
      return
    }

    const currentParentPath = unavailableParents.get(dirPath)
    if (currentParentPath === parentPath) return
    if (currentParentPath) release(dirPath)

    let entry = parentWatchers.get(parentPath)
    if (!entry) {
      try {
        const targetPaths = new Set<string>()
        const watcher = watchDirectory(parentPath, { recursive: false }, (_eventType, filename) => {
          // 目录恢复、替换或权限变化后，通知 renderer 重新读取即时 root status。
          const normalizedFilename = normalizeWatchFilename(filename)
          if (normalizedFilename === null) {
            // filename 不可用时，仅在目标目录已经恢复时通知，避免未知噪声绕过过滤。
            if ([...targetPaths].some((targetPath) => deps.isExistingDirectory(targetPath))) {
              deps.notifyFilesChanged()
            }
            return
          }

          const changedPath = resolve(parentPath, normalizedFilename)
          const isTargetRecovery = [...targetPaths].some((targetPath) => resolve(targetPath) === changedPath)
          if (!isTargetRecovery && isHighNoisePath(normalizedFilename)) return
          deps.notifyFilesChanged()
        })
        entry = { watcher, targetPaths }
        parentWatchers.set(parentPath, entry)

        watcher.on('error', (err) => {
          console.error('[附加目录监听] 父目录监听出错，等待下次访问重建:', parentPath, err)
          try { watcher.close() } catch { /* watcher 可能已自动关闭 */ }
          parentWatchers.delete(parentPath)
          const pathsToRestore = [...targetPaths]
          for (const targetPath of pathsToRestore) {
            unavailableParents.delete(targetPath)
          }
          deps.scheduleRestart(() => {
            for (const targetPath of pathsToRestore) {
              if (!unavailableParents.has(targetPath)) deps.watchDirectory(targetPath)
            }
          })
        })
        console.log('[附加目录监听] 已启动父目录监听:', parentPath)
      } catch (error) {
        console.error('[附加目录监听] 启动父目录监听失败:', parentPath, error)
        return
      }
    }

    entry.targetPaths.add(dirPath)
    unavailableParents.set(dirPath, parentPath)
  }

  function dispose(): void {
    for (const [parentPath, entry] of parentWatchers) {
      try { entry.watcher.close() } catch { /* watcher 可能已自动关闭 */ }
      console.log('[附加目录监听] 已停止父目录监听:', parentPath)
    }
    parentWatchers.clear()
    unavailableParents.clear()
  }

  return { watch, release, dispose }
}