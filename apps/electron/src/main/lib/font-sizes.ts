/**
 * 全局字号步进与跨窗口同步。
 *
 * 官方 0.22.0：内容/代码/终端三条字号轴统一持久化到 settings.json，
 * Cmd+= / Cmd+- 每次步进 1px，Cmd+0 回到默认值；所有窗口通过
 * SETTINGS_IPC_CHANNELS.ON_FONT_SETTINGS_CHANGED 接收完整快照。
 */

import { BrowserWindow } from 'electron'
import {
  DEFAULT_FONT_SIZES,
  SETTINGS_IPC_CHANNELS,
  clampFontSize,
  resolveFontSizes,
  type AppFontSizes,
  type FontRole,
} from '../../types'
import { getSettings, updateSettings } from './settings-service'

const FONT_ROLES: readonly FontRole[] = ['content', 'code', 'terminal']

export function broadcastFontSizes(sizes: AppFontSizes, exceptWebContentsId?: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    if (win.webContents.id === exceptWebContentsId) continue
    try {
      win.webContents.send(SETTINGS_IPC_CHANNELS.ON_FONT_SETTINGS_CHANGED, sizes)
    } catch (error) {
      console.warn('[设置] 同步字号到窗口失败:', error)
    }
  }
}

export function persistFontSizes(sizes: AppFontSizes): AppFontSizes {
  updateSettings({
    contentFontSize: sizes.content,
    codeFontSize: sizes.code,
    terminalFontSize: sizes.terminal,
  })
  broadcastFontSizes(sizes)
  return sizes
}

/** 三条轴同时步进；任一轴到达边界时该轴保持不变。 */
export function stepFontSizesInMain(delta: number): void {
  const current = resolveFontSizes(getSettings())
  const next: AppFontSizes = { ...current }
  for (const role of FONT_ROLES) {
    next[role] = clampFontSize(role, current[role] + delta)
  }
  if (FONT_ROLES.every((role) => next[role] === current[role])) return
  persistFontSizes(next)
}

export function resetFontSizesInMain(): void {
  persistFontSizes({ ...DEFAULT_FONT_SIZES })
}
