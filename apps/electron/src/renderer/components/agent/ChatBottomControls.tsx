/**
 * 对话区底部控制。
 *
 * 官方 0.22.0 下线了任务进度浮层与任务工具族；这里只保留两个仍然必要的能力：
 * - 不在底部时提供「回到最下方」按钮；
 * - 上下文压缩的进行中/终态反馈。
 */

import * as React from 'react'
import { ArrowDownIcon, CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useStickToBottomContext } from 'use-stick-to-bottom'

const FINISH_RETENTION_MS = 4_000
const FADE_OUT_DURATION_MS = 200

export interface ContextCompactionProgress {
  status: 'running' | 'success' | 'noop' | 'failed'
  label: string
  detail?: string
  summary?: string
}

function compactionSignature(progress: ContextCompactionProgress): string {
  return `${progress.status}:${progress.label}:${progress.detail ?? ''}:${progress.summary ?? ''}`
}

export function shouldRestoreCompactionProgress(signature: string, dismissedSignature: string): boolean {
  return signature !== dismissedSignature
}

/**
 * 压缩成功后，如果同一个 stream 已恢复正常工作，保留的终态反馈不能继续覆盖新的运行状态。
 */
export function shouldClearRetainedCompactionForResumedStream(
  streaming: boolean,
  contextCompaction: ContextCompactionProgress | undefined,
  retainedCompaction: ContextCompactionProgress | undefined,
): boolean {
  return streaming && !contextCompaction && !!retainedCompaction
}

function CompactionProgressDetails({ progress }: { progress: ContextCompactionProgress }): React.ReactElement {
  const isRunning = progress.status === 'running'
  const isFailed = progress.status === 'failed'

  return (
    <div className="space-y-3 p-1">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          {isRunning && <Loader2 className="size-4 animate-spin text-blue-500" />}
          {progress.status === 'success' && <CheckCircle2 className="size-4 text-green-500" />}
          {progress.status === 'noop' && <CheckCircle2 className="size-4 text-muted-foreground" />}
          {isFailed && <CircleAlert className="size-4 text-destructive" />}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-[13px] font-medium text-foreground">{progress.label}</div>
          {progress.detail && <p className="text-xs text-muted-foreground">{progress.detail}</p>}
        </div>
      </div>
      {progress.summary && !isRunning && (
        <p className="max-h-28 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
          {progress.summary}
        </p>
      )}
    </div>
  )
}

interface ChatBottomControlsProps {
  /** 与对话并列的系统级短时操作；当前用于上下文压缩。 */
  contextCompaction?: ContextCompactionProgress
  streaming: boolean
}

export function ChatBottomControls({ contextCompaction, streaming }: ChatBottomControlsProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const [retainedCompaction, setRetainedCompaction] = React.useState<ContextCompactionProgress | undefined>()
  const [retainedCompactionSignature, setRetainedCompactionSignature] = React.useState('')
  const [dismissedCompactionSignature, setDismissedCompactionSignature] = React.useState('')
  const [visible, setVisible] = React.useState(false)
  const [fading, setFading] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  const liveCompactionSignature = contextCompaction ? compactionSignature(contextCompaction) : ''

  React.useEffect(() => {
    if (!contextCompaction) return
    if (contextCompaction.status === 'running' && dismissedCompactionSignature) {
      setDismissedCompactionSignature('')
    }
    if (
      liveCompactionSignature === retainedCompactionSignature
      || !shouldRestoreCompactionProgress(liveCompactionSignature, dismissedCompactionSignature)
    ) return
    setRetainedCompaction(contextCompaction)
    setRetainedCompactionSignature(liveCompactionSignature)
    setFading(false)
    setVisible(true)
  }, [contextCompaction, dismissedCompactionSignature, liveCompactionSignature, retainedCompactionSignature])

  React.useEffect(() => {
    if (!shouldClearRetainedCompactionForResumedStream(streaming, contextCompaction, retainedCompaction)) return
    setRetainedCompaction(undefined)
    setRetainedCompactionSignature('')
    setFading(false)
    setVisible(false)
  }, [streaming, contextCompaction, retainedCompaction])

  const displayCompaction = contextCompaction ?? retainedCompaction
  const displayCompactionSignature = displayCompaction ? compactionSignature(displayCompaction) : ''
  const compactionIsRunning = displayCompaction?.status === 'running'
  const shouldRetainFinishedProgress = !!displayCompaction
    && !compactionIsRunning
    && displayCompaction.status !== 'failed'
  const hideKey = shouldRetainFinishedProgress
    ? `${displayCompactionSignature}:${streaming}`
    : null

  React.useEffect(() => {
    if (!hideKey) {
      if (displayCompaction) {
        setFading(false)
        setVisible(true)
      }
      return
    }

    const fadeTimer = window.setTimeout(() => {
      setFading(true)
    }, FINISH_RETENTION_MS - FADE_OUT_DURATION_MS)
    const hideTimer = window.setTimeout(() => {
      setDismissedCompactionSignature(displayCompactionSignature)
      setVisible(false)
      setOpen(false)
      setRetainedCompaction(undefined)
      setRetainedCompactionSignature('')
    }, FINISH_RETENTION_MS)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(hideTimer)
    }
  }, [displayCompaction, displayCompactionSignature, hideKey])

  const showCompaction = visible && !!displayCompaction

  if (!showCompaction && isAtBottom) return null

  if (!showCompaction) {
    return (
      <Button
        className="absolute bottom-[26px] left-1/2 size-10 -translate-x-1/2 rounded-md border border-border/60 bg-background/85 shadow-sm backdrop-blur-sm transition-[background-color,transform] duration-200 hover:bg-accent/80 active:scale-[0.96]"
        onClick={() => scrollToBottom()}
        type="button"
        variant="ghost"
        aria-label="回到最下方"
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  }

  return (
    <div className={cn(
      'pointer-events-none absolute bottom-[22px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 transition-opacity duration-200',
      fading && 'opacity-0',
    )}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              // 官方 0.22.80：压缩进度在对话内以单行纯文本呈现，字号与正文一致；
              // 不再使用卡片/阴影，避免压缩期间抢走阅读焦点。
              'pointer-events-auto flex max-w-[min(460px,calc(100vw-9rem))] items-center gap-2 py-1 text-left text-sm text-muted-foreground',
              'transition-opacity duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {displayCompaction.status === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />}
            {displayCompaction.status === 'success' && <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />}
            {displayCompaction.status === 'noop' && <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />}
            {displayCompaction.status === 'failed' && <CircleAlert className="size-3.5 shrink-0 text-destructive" />}
            <span className="truncate text-sm" title={displayCompaction.label}>{displayCompaction.label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(420px,calc(100vw-2rem))] rounded-md border-border/60 bg-background/95 p-2 backdrop-blur-sm" side="top" align="center">
          <CompactionProgressDetails progress={displayCompaction} />
        </PopoverContent>
      </Popover>

      {!isAtBottom && (
        <Button
          aria-label="回到最下方"
          className="pointer-events-auto size-10 rounded-md border border-border/60 bg-background/85 shadow-sm backdrop-blur-sm transition-[background-color,transform] duration-200 hover:bg-accent/80 active:scale-[0.96]"
          onClick={() => scrollToBottom()}
          type="button"
          variant="ghost"
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
