/**
 * 工作区监听的事件通知
 *
 * 统一管理主窗口引用与 debounce 定时器，主工作区与附加目录共享同一套
 * WORKSPACE_FILES_CHANGED / CAPABILITIES_CHANGED 语义，避免多路事件造成渲染进程风暴。
 */

import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'

/** 工作区监听的 debounce 延迟（ms），目录观察器与通知发送共用 */
export const WORKSPACE_WATCH_DEBOUNCE_MS = 300

let mainWin: BrowserWindow | null = null
let filesNotifyTimer: ReturnType<typeof setTimeout> | null = null
const pendingChangedPaths = new Set<string>()
let capabilitiesTimer: ReturnType<typeof setTimeout> | null = null

export function setWorkspaceWatcherWindow(win: BrowserWindow | null): void {
  mainWin = win
}

/** 合并同一 debounce 窗口内的文件变更，去重后一次性推送 */
export function notifyWorkspaceFilesChanged(changedPaths?: string | readonly string[]): void {
  if (!mainWin || mainWin.isDestroyed()) return

  if (filesNotifyTimer) clearTimeout(filesNotifyTimer)
  if (typeof changedPaths === 'string') pendingChangedPaths.add(changedPaths)
  else if (changedPaths) for (const path of changedPaths) pendingChangedPaths.add(path)

  filesNotifyTimer = setTimeout(() => {
    const paths = [...pendingChangedPaths]
    pendingChangedPaths.clear()
    filesNotifyTimer = null
    if (mainWin && !mainWin.isDestroyed()) {
      // 保留删除路径，使当前预览也能从旧缓存切换到“文件不存在”状态。
      mainWin.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, paths)
    }
  }, WORKSPACE_WATCH_DEBOUNCE_MS)
}

export function notifyCapabilitiesChanged(win: BrowserWindow): void {
  if (capabilitiesTimer) clearTimeout(capabilitiesTimer)
  capabilitiesTimer = setTimeout(() => {
    capabilitiesTimer = null
    if (!win.isDestroyed()) win.webContents.send(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED)
  }, WORKSPACE_WATCH_DEBOUNCE_MS)
}

/** 停止监听时释放定时器与待发送路径 */
export function resetWorkspaceWatcherNotifications(): void {
  if (filesNotifyTimer) clearTimeout(filesNotifyTimer)
  filesNotifyTimer = null
  pendingChangedPaths.clear()
  if (capabilitiesTimer) clearTimeout(capabilitiesTimer)
  capabilitiesTimer = null
  mainWin = null
}