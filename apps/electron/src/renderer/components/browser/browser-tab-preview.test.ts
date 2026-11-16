import { describe, expect, test } from 'bun:test'
import {
  BROWSER_PREVIEW_PANEL_WIDTH,
  formatBrowserPreviewUrl,
  isSafeBrowserPreviewImage,
  resolveBrowserPreviewPosition,
} from './browser-tab-preview'

describe('浏览器标签缩略图', () => {
  test('Given 主进程返回 JPEG data URL When 校验 Then 接受', () => {
    expect(isSafeBrowserPreviewImage('data:image/jpeg;base64,AAAA')).toBe(true)
    expect(isSafeBrowserPreviewImage('data:image/png;base64,AAAA')).toBe(false)
    expect(isSafeBrowserPreviewImage('https://example.com/x.jpg')).toBe(false)
    expect(isSafeBrowserPreviewImage('data:image/jpeg;base64,')).toBe(false)
  })

  test('Given 靠右 Tab When 定位 Then 卡片向内收且不越界', () => {
    const position = resolveBrowserPreviewPosition(
      { left: 1000, bottom: 40 },
      1024,
      768,
    )
    expect(position.left).toBe(1024 - BROWSER_PREVIEW_PANEL_WIDTH - 8)
    expect(position.left).toBeGreaterThanOrEqual(8)
    expect(position.top).toBe(46)
  })

  test('Given 靠下 Tab When 定位 Then 顶部不超出窗口', () => {
    const position = resolveBrowserPreviewPosition(
      { left: 20, bottom: 760 },
      1024,
      768,
    )
    expect(position.top).toBeLessThanOrEqual(768 - 180)
  })

  test('Given URL When 显示 Then 去掉根路径与查询参数细节', () => {
    expect(formatBrowserPreviewUrl('https://example.com/')).toBe('example.com')
    expect(formatBrowserPreviewUrl('https://example.com/docs?x=1')).toBe('example.com/docs')
    expect(formatBrowserPreviewUrl('')).toBe('空白页')
  })
})
