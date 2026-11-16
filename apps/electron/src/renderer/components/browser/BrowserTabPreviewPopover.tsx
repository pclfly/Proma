/**
 * 浏览器 Tab 悬浮缩略图。
 *
 * 只消费主进程已经授权的 `getAgentBrowserPreview`，不在 renderer 读取网页内容。
 * 鼠标停在右侧工作区 Tab 上时每 1.2s 刷新一次；主进程内部还有 700ms 缓存。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Globe, LoaderCircle } from 'lucide-react'
import type { BrowserPreviewFrame } from '@proma/shared'
import {
  BROWSER_PREVIEW_POLL_MS,
  formatBrowserPreviewUrl,
  isSafeBrowserPreviewImage,
  resolveBrowserPreviewPosition,
} from './browser-tab-preview'

interface BrowserTabPreviewPopoverProps {
  sessionId: string
  tabId: string
  anchor: HTMLElement | null
  onMouseEnter: () => void
  onMouseLeave: () => void
}

export function BrowserTabPreviewPopover({
  sessionId,
  tabId,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: BrowserTabPreviewPopoverProps): React.ReactElement | null {
  const [frame, setFrame] = React.useState<BrowserPreviewFrame | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    let loading = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = async (): Promise<void> => {
      if (cancelled || loading || document.hidden) return
      const api = window.electronAPI as Partial<typeof window.electronAPI>
      if (typeof api.getAgentBrowserPreview !== 'function') return
      loading = true
      try {
        const next = await api.getAgentBrowserPreview({ sessionId, tabId })
        if (cancelled) return
        if (!next) {
          setFrame(null)
          setFailed(false)
          return
        }
        if (!isSafeBrowserPreviewImage(next.imageDataUrl)) {
          setFailed(true)
          return
        }
        const image = new Image()
        image.src = next.imageDataUrl
        await image.decode()
        if (cancelled) return
        setFrame(next)
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        loading = false
        if (!cancelled) timer = setTimeout(() => void load(), BROWSER_PREVIEW_POLL_MS)
      }
    }

    const onVisibilityChange = (): void => {
      if (document.hidden) return
      if (timer) clearTimeout(timer)
      void load()
    }

    void load()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sessionId, tabId])

  React.useLayoutEffect(() => {
    if (!anchor) return
    const update = (): void => {
      const rect = anchor.getBoundingClientRect()
      setPosition(resolveBrowserPreviewPosition(
        { left: rect.left, bottom: rect.bottom },
        window.innerWidth,
        window.innerHeight,
      ))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  if (!anchor || !position) return null

  const imageUrl = frame && isSafeBrowserPreviewImage(frame.imageDataUrl) ? frame.imageDataUrl : null
  const label = frame ? formatBrowserPreviewUrl(frame.url) : ''

  return createPortal(
    <div
      className="fixed z-[9999]"
      style={{ top: position.top, left: position.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid="browser-tab-preview"
    >
      <div className="w-[248px] overflow-hidden rounded-xl border border-border/80 bg-popover text-popover-foreground shadow-xl">
        <div className="relative aspect-[16/10] bg-muted/40">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="浏览器标签预览"
              className="h-full w-full object-cover"
              draggable={false}
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              {failed ? (
                <>
                  <Globe className="size-5 opacity-50" />
                  <span>预览暂不可用</span>
                </>
              ) : (
                <>
                  <LoaderCircle className="size-4 animate-spin opacity-60" />
                  <span>正在生成预览</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 border-t border-border/50 px-2.5 py-1.5">
          <Globe className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate text-[11px] text-muted-foreground" title={frame?.url ?? ''}>
            {label || '正在读取页面'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
