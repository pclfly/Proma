/**
 * Computer Use 预览浮层。
 *
 * 主进程的 ComputerUsePreview 工具只登记目标并截图；renderer 负责轮询状态并展示。
 * 浮层放在主内容区左侧，避免被右侧原生 WebContentsView 遮挡。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AppWindow, Loader2, Maximize2, RefreshCw, X } from 'lucide-react'
import type { ComputerUsePreviewState } from '@proma/shared'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 1_200

function isPreviewImage(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length > 30
}

export function ComputerUsePreviewOverlay(): React.ReactElement | null {
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const [preview, setPreview] = React.useState<ComputerUsePreviewState | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    setPreview(null)
    if (!sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = async (): Promise<void> => {
      const api = window.electronAPI as Partial<typeof window.electronAPI>
      if (cancelled || typeof api.getComputerUsePreview !== 'function') return
      try {
        const state = await api.getComputerUsePreview(sessionId, false)
        if (cancelled) return
        if (!state) {
          setPreview(null)
        } else if (state.status === 'running' && state.transport === 'snapshot') {
          const captured = await api.getComputerUsePreview(sessionId, true)
          if (!cancelled) setPreview(captured ?? state)
        } else {
          setPreview(state)
        }
      } catch {
        if (!cancelled) setPreview(null)
      }
      if (!cancelled) timer = setTimeout(() => void load(), POLL_INTERVAL_MS)
    }

    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId])

  const dismiss = React.useCallback(async (): Promise<void> => {
    if (!preview || !sessionId) return
    setBusy(true)
    try {
      await window.electronAPI.dismissComputerUsePreview(sessionId, preview.id)
      setPreview(null)
    } catch {
      // 主进程状态已消失时保持静默。
    } finally {
      setBusy(false)
    }
  }, [preview, sessionId])

  const activate = React.useCallback(async (): Promise<void> => {
    if (!preview || !sessionId || preview.target !== 'window') return
    setBusy(true)
    try {
      await window.electronAPI.activateComputerUsePreview(sessionId, preview.id)
    } finally {
      setBusy(false)
    }
  }, [preview, sessionId])

  const retry = React.useCallback(async (): Promise<void> => {
    if (!preview || !sessionId) return
    setBusy(true)
    try {
      const next = await window.electronAPI.retryComputerUsePreview(sessionId, preview.id)
      setPreview(next)
    } finally {
      setBusy(false)
    }
  }, [preview, sessionId])

  if (!preview || preview.status === 'finished') return null
  const image = isPreviewImage(preview.image) ? preview.image : null

  return (
    <aside
      className="fixed left-4 top-16 z-[9000] w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border/80 bg-popover text-popover-foreground shadow-2xl"
      data-testid="computer-use-preview"
      aria-label="Computer Use 预览"
    >
      <header className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
        <AppWindow className="size-3.5 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{preview.label}</span>
        <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {preview.target === 'desktop' ? '桌面' : '窗口'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={() => void dismiss()}
          disabled={busy}
          aria-label="关闭 Computer Use 预览"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="relative aspect-[16/10] bg-muted/50">
        {preview.status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-muted-foreground">
            <span>{preview.error ?? '预览暂不可用'}</span>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => void retry()}>
              <RefreshCw className="size-3" />
              重试
            </Button>
          </div>
        ) : image ? (
          <img
            src={image}
            alt={`${preview.label} 预览`}
            className="h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-muted-foreground">
            {preview.transport === 'native-stream' ? (
              <>
                <Maximize2 className="size-5 opacity-50" />
                <span>原生窗口流预览中</span>
              </>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin opacity-60" />
                <span>正在截取窗口画面</span>
              </>
            )}
          </div>
        )}
      </div>

      <footer className="flex h-8 items-center gap-2 border-t border-border/60 px-3 text-[10px] text-muted-foreground">
        <span className={cn(
          'size-1.5 rounded-full',
          preview.status === 'running' ? 'bg-emerald-500' : preview.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/50',
        )} />
        <span className="min-w-0 flex-1 truncate">
          {preview.status === 'running' ? 'Agent 正在操作' : preview.status === 'error' ? '预览不可用' : '已结束'}
          {preview.capturedAt ? ` · ${new Date(preview.capturedAt).toLocaleTimeString()}` : ''}
        </span>
        {preview.target === 'window' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => void activate()}
            disabled={busy}
          >
            切到前台
          </Button>
        )}
      </footer>
    </aside>
  )
}
