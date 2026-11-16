/**
 * 浏览器标签缩略图的纯逻辑：轮询间隔、图片 URL 校验与悬浮定位。
 */

export const BROWSER_PREVIEW_POLL_MS = 1_000
export const BROWSER_PREVIEW_PANEL_WIDTH = 248

export function isSafeBrowserPreviewImage(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('data:image/jpeg;base64,')
    && value.length > 'data:image/jpeg;base64,'.length
}

export interface BrowserPreviewAnchorRect {
  left: number
  bottom: number
}

/** 悬浮卡片默认贴在 Tab 下方；靠近右/下边缘时向内收，避免超出窗口。 */
export function resolveBrowserPreviewPosition(
  anchor: BrowserPreviewAnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  panelWidth = BROWSER_PREVIEW_PANEL_WIDTH,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - panelWidth - margin)
  const left = Math.min(Math.max(anchor.left, margin), maxLeft)
  const top = Math.min(anchor.bottom + 6, Math.max(margin, viewportHeight - 180))
  return { left, top }
}

export function formatBrowserPreviewUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return '空白页'
  try {
    const parsed = new URL(trimmed)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return trimmed
  }
}
