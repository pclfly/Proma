import { DEFAULT_MARKDOWN_FONT_SIZE, SETTINGS_IPC_CHANNELS, isMarkdownFontSize } from '../../types'
import type { AppSettings, ReadingSettingsChangedEvent } from '../../types'

/** 只依赖广播所需接口，避免设置逻辑绑定窗口创建方式。 */
export interface ReadingSettingsTarget {
  isDestroyed: () => boolean
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, payload: ReadingSettingsChangedEvent) => void
  }
}

/** 必须在设置成功保存后调用；窗口关闭竞争不应使已保存的设置报告失败。 */
export function broadcastReadingSettings(
  windows: readonly ReadingSettingsTarget[],
  updates: Partial<AppSettings>,
  settings: AppSettings,
): void {
  if (updates.markdownFontSize === undefined) return
  const payload: ReadingSettingsChangedEvent = {
    markdownFontSize: isMarkdownFontSize(settings.markdownFontSize) ? settings.markdownFontSize : DEFAULT_MARKDOWN_FONT_SIZE,
  }
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(SETTINGS_IPC_CHANNELS.ON_READING_SETTINGS_CHANGED, payload)
      }
    } catch (error) {
      console.warn('[阅读设置] 窗口广播失败:', error)
    }
  }
}
