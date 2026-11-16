/**
 * InputQuotaIsland — 输入框工具栏常驻额度胶囊。
 *
 * - 只展示供应商真实返回的 5H / 周窗口；缺失的窗口不补 0。
 * - 悬停显示来源、档位与更新时间；点开查看全部来源。
 * - 宽度不足时隐藏文字，只保留紧凑图标，避免挤压输入区。
 * - 刷新由首次进入、渠道变化、展开与主进程推送触发，不做后台轮询。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, Gauge, Loader2, RefreshCw } from 'lucide-react'
import type { PlanQuotaSource, PlanQuotaWindow } from '@proma/shared'
import { channelsAtom, channelsLoadedAtom } from '@/atoms/channel-atoms'
import {
  applyPlanQuotaSnapshotAtom,
  currentPlanQuotaSnapshot,
  ensurePlanQuotaAtom,
  planQuotaChannelsSignature,
  planQuotaStateAtom,
  refreshPlanQuotaAtom,
} from '@/atoms/plan-quota-atoms'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatPlanQuotaCountdown,
  formatPlanQuotaSourceSummary,
  formatPlanQuotaUpdatedAt,
  formatPlanQuotaWindowLabel,
  formatPlanQuotaWindowValue,
  selectPlanQuotaIslandWindows,
} from '@/lib/plan-quota-display'

/** 仅用于本地倒计时重算，不代表任何网络轮询。 */
const COUNTDOWN_TICK_MS = 30_000

function WindowChip({ window, now }: { window: PlanQuotaWindow; now: number }): React.ReactElement {
  const countdown = formatPlanQuotaCountdown(window.resetAt, now)
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="font-medium text-foreground/65">{formatPlanQuotaWindowLabel(window)}</span>
      <span className="tabular-nums text-foreground/80">{formatPlanQuotaWindowValue(window)}</span>
      {countdown && <span className="tabular-nums text-[10px] text-muted-foreground/75">{countdown}</span>}
    </span>
  )
}

function WindowRow({ window, now }: { window: PlanQuotaWindow; now: number }): React.ReactElement {
  const countdown = formatPlanQuotaCountdown(window.resetAt, now)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span className="shrink-0 tabular-nums text-foreground/80">{formatPlanQuotaWindowValue(window)}</span>
      </div>
      {window.showProgress !== false && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/70 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/75">
        <span>剩余 {window.remainingPercent}%</span>
        <span>{countdown ?? '未提供重置时间'}</span>
      </div>
    </div>
  )
}

function SourceBlock({ source, now }: { source: PlanQuotaSource; now: number }): React.ReactElement {
  const plan = [source.planName, source.tier]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' · ')
  const hasCreditWindow = source.windows.some(
    (window) => window.remainingLabel === source.credits?.remainingLabel,
  )

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{source.label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/75">
          {formatPlanQuotaUpdatedAt(source.updatedAt)}
        </span>
      </div>
      {plan && <div className="truncate text-[11px] text-muted-foreground">{plan}</div>}

      {source.windows.map((window, index) => (
        <WindowRow key={`${window.type}-${index}`} window={window} now={now} />
      ))}

      {source.credits && !hasCreditWindow && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">积分余额</span>
          <span className="tabular-nums text-foreground/80">
            {source.credits.remainingLabel ?? `${source.credits.remaining} ${source.credits.unit}`}
          </span>
        </div>
      )}

      {source.error && (
        <div className="flex items-start gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">额度暂不可用：{source.error}</span>
        </div>
      )}
      {source.stale && (
        <div className="text-[10px] text-muted-foreground/75">显示上次成功数据，可能已过期</div>
      )}
    </div>
  )
}

export function InputQuotaIsland({ channelId }: { channelId?: string | null }): React.ReactElement | null {
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const state = useAtomValue(planQuotaStateAtom)
  const ensure = useSetAtom(ensurePlanQuotaAtom)
  const refresh = useSetAtom(refreshPlanQuotaAtom)
  const applySnapshot = useSetAtom(applyPlanQuotaSnapshotAtom)
  const [open, setOpen] = React.useState(false)
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  const signature = planQuotaChannelsSignature(channels)
  const snapshot = channelsLoaded
    ? currentPlanQuotaSnapshot(state, signature)
    : state.snapshot

  React.useEffect(() => {
    void ensure()
  }, [ensure])

  React.useEffect(() => {
    return window.electronAPI.onPlanQuotaChanged((next) => applySnapshot(next))
  }, [applySnapshot])

  const previousSignature = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!channelsLoaded) return
    const previous = previousSignature.current
    previousSignature.current = signature
    // 首次拿到渠道列表、渠道签名变化或旧快照签名不一致时同步一次。
    if (previous !== signature || state.snapshot === null || state.signature !== signature) {
      void refresh('auto')
    }
  }, [channelsLoaded, signature, state.snapshot, state.signature, refresh])

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) void refresh('manual')
  }

  const primary = snapshot?.sources.find((source) => source.channelId === channelId)
    ?? snapshot?.sources[0]
  if (!snapshot || !primary) return null

  const windows = selectPlanQuotaIslandWindows(primary)
  const tooltipText = snapshot.sources.map(formatPlanQuotaSourceSummary).join('\n')
  const hasError = windows.length === 0 && Boolean(primary.error)
  const isStale = primary.stale === true
  const fallbackCredit = primary.credits?.remainingLabel
    ?? (primary.credits ? `${primary.credits.remaining} ${primary.credits.unit}` : undefined)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <span className="shrink-0">
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={tooltipText || '订阅额度'}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  hasError
                    ? 'border-destructive/25 bg-destructive/5 text-destructive'
                    : isStale
                      ? 'border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                      : 'border-foreground/10 bg-background/60 text-foreground/70 hover:bg-muted/60',
                )}
              >
                {state.loading
                  ? <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  : hasError || isStale
                    ? <AlertTriangle className="size-3.5 shrink-0" />
                    : <Gauge className="size-3.5 shrink-0" />}
                <span className="hidden items-center gap-1.5 sm:inline-flex">
                  {windows.length > 0
                    ? windows.map((window, index) => (
                      <React.Fragment key={`${window.type}-${index}`}>
                        {index > 0 && <span className="text-muted-foreground/40">·</span>}
                        <WindowChip window={window} now={now} />
                      </React.Fragment>
                    ))
                    : <span>{fallbackCredit ?? '额度暂不可用'}</span>}
                </span>
              </button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-xs whitespace-pre-line">
          {tooltipText}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 space-y-2.5 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">订阅额度</span>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>
              {snapshot.refreshedAt > 0
                ? `更新于 ${formatPlanQuotaUpdatedAt(snapshot.refreshedAt)}`
                : '尚未刷新'}
            </span>
            <button
              type="button"
              onClick={() => void refresh('manual')}
              disabled={state.loading}
              aria-label="刷新额度"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', state.loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {snapshot.stale && (
          <div className="rounded-md bg-muted/60 px-2 py-1.5 text-[10px] text-muted-foreground">
            当前显示上次成功数据，刷新失败时不会归零。
          </div>
        )}

        <div className="max-h-80 space-y-3 overflow-y-auto pr-0.5">
          {snapshot.sources.map((source) => (
            <SourceBlock key={source.channelId} source={source} now={now} />
          ))}
        </div>

        {state.error && (
          <div className="text-[10px] text-destructive">额度暂不可用：{state.error}</div>
        )}
      </PopoverContent>
    </Popover>
  )
}
