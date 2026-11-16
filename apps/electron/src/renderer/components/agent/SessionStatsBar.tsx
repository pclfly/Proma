/**
 * SessionStatsBar — 输入框下方的会话状态栏
 *
 * 版式对齐 DeepSeek Harness 的 composer 统计：整条居中，三组读数各带图标，
 * 组内用 `·` 分隔：
 *   (↻) 2 轮 50 步 · 171 tok/s   (▤) 33.4M tok · 缓存命中 98.6%   (◔) 23%
 *
 * 设计要点：
 * - 折叠分两层：持久化历史只在快照变化时折一次，流式期间只对新增实时消息做增量折叠。
 *   delta 逐帧到达时不能全量重扫历史，否则长会话每帧都是 O(历史长度)。
 * - 读数缺失时整段隐藏，不用 0 占位——0 tok/s 和「还没开始生成」是两回事。
 * - 上下文使用率接近自动压缩阈值时变琥珀色，与 ContextUsageBadge 的预警语义一致。
 * - 三组读数各自是胶囊：悬停高亮为选中态，点击向上展开明细（参考 ZCode composer dock）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Database, Gauge } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  agentLiveMessagesAtomFamily,
  agentModelIdAtom,
  agentSDKMessagesCacheAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSessionStreamingStateAtomFamily,
  agentSessionsAtom,
  agentChannelIdAtom,
} from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/channel-atoms'
import { cn } from '@/lib/utils'
import {
  collectMessageUuids,
  foldSessionUsageInto,
  formatCompactTokens,
  formatStatDuration,
  formatTokensPerSecond,
  liveMessagesNotInPersisted,
  statsFromFold,
  type UsageFold,
} from '@/lib/session-stats'
import { calculatePiAutoCompactionThresholdTokens, inferContextWindow } from '@proma/shared'

/** 接近自动压缩阈值时转为警告色的比例（与 ContextUsageBadge 一致） */
const WARNING_RATIO = 0.8

interface SessionStatsBarProps {
  sessionId: string
  /** 嵌入右侧工作区时不显示，避免窄面板里挤掉输入区 */
  embedded?: boolean
  className?: string
}

/** 组内分隔符：最弱的一档，但不至于看不见 */
function Sep(): React.ReactElement {
  return <span className="mx-1 text-foreground/60" aria-hidden>·</span>
}

interface DetailRowItem {
  label: string
  value: string
  emphasized?: boolean
}

/** 胶囊明细：标题 + 分隔线 + 两列读数 + 说明。 */
function DetailPanel({
  icon,
  title,
  value,
  rows,
  note,
  extra,
}: {
  icon: React.ReactNode
  title: string
  value?: string
  rows: DetailRowItem[]
  note?: string
  extra?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <span className="shrink-0 text-foreground/60">{icon}</span>
          <span className="truncate">{title}</span>
        </span>
        {value && <span className="shrink-0 tabular-nums text-muted-foreground">{value}</span>}
      </div>
      {extra}
      <div className="h-px bg-border/60" />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-foreground/60">{row.label}</dt>
            <dd className={cn(
              'text-right font-medium tabular-nums',
              row.emphasized ? 'text-foreground' : 'text-foreground/90',
            )}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {note && <p className="text-[11px] leading-4 text-muted-foreground/70">{note}</p>}
    </div>
  )
}

/** 状态栏胶囊：悬停高亮为选中态，点击向上展开明细。 */
function StatPill({
  icon,
  children,
  detail,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  detail: React.ReactNode
}): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            '-my-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 tabular-nums transition-colors',
            'hover:bg-foreground/[0.08] hover:text-foreground',
            'data-[state=open]:bg-foreground/[0.10] data-[state=open]:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
          )}
        >
          <span className="shrink-0 text-foreground/55">{icon}</span>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-[min(320px,calc(100vw-24px))] p-3.5"
      >
        {detail}
      </PopoverContent>
    </Popover>
  )
}

/** 数值 + 单位：数值最亮、单位次之。整行底色是暗色，两者都不能低于 60% 否则糊成一片 */
function Value({ value, unit }: { value: string; unit?: string }): React.ReactElement {
  return (
    <>
      <span className="font-medium text-foreground/90">{value}</span>
      {unit != null && <span className="ml-0.5 text-foreground/60">{unit}</span>}
    </>
  )
}

export function SessionStatsBar({ sessionId, embedded, className }: SessionStatsBarProps): React.ReactElement | null {
  const persisted = useAtomValue(agentSDKMessagesCacheAtom).get(sessionId)
  const liveMessages = useAtomValue(agentLiveMessagesAtomFamily(sessionId))
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const channels = useAtomValue(channelsAtom)
  const defaultChannelId = useAtomValue(agentChannelIdAtom)
  const defaultModelId = useAtomValue(agentModelIdAtom)
  // 与 AgentView 保持同一优先级：会话自身选择（元数据 > 会话 Map）优先于全局默认值。
  // 之前只读全局默认值，历史会话或换过模型的会话会拿另一个模型的窗口去算百分比。
  const sessionMeta = useAtomValue(agentSessionsAtom).find((item) => item.id === sessionId)
  const sessionChannelMap = useAtomValue(agentSessionChannelMapAtom)
  const sessionModelMap = useAtomValue(agentSessionModelMapAtom)
  const agentChannelId = sessionMeta?.channelId ?? sessionChannelMap.get(sessionId) ?? defaultChannelId
  const agentModelId = sessionMeta?.modelId ?? sessionModelMap.get(sessionId) ?? defaultModelId

  // 第一层：持久化历史只在快照引用变化时重折。
  const persistedFold = React.useMemo<UsageFold>(
    () => foldSessionUsageInto(
      {
        promptTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        timedOutputTokens: 0,
        decodeMs: 0,
        lastMainPromptTokens: null,
        lastMainModelId: null,
        turns: 0,
        steps: 0,
      },
      persisted ?? [],
    ),
    [persisted],
  )
  const persistedUuids = React.useMemo(
    () => collectMessageUuids(persisted ?? []),
    [persisted],
  )

  // 第二层：只折本轮新增的实时消息，且跳过已落盘的重复 uuid。
  const totalFold = React.useMemo<UsageFold>(() => {
    const fresh = liveMessagesNotInPersisted(persisted ?? [], liveMessages, persistedUuids)
    return foldSessionUsageInto(persistedFold, fresh)
  }, [persistedFold, persisted, persistedUuids, liveMessages])

  // 用户为渠道模型显式配置的窗口优先于按模型名推断：自定义网关上的模型
  // （如 baidu/ernie-5.5-flash-preview:free）不在推断表内，缺失运行时事件时会
  // 永久回落到 200K 默认值，与用户在渠道里配置的 1M 不一致。
  // 模型归属优先取本轮实际运行的模型，其次取用户刚选中的模型：换模型后若仍按上一次
  // 落盘消息的模型解析，会把旧模型的窗口（例如 200K）误用到新模型上。
  const configuredContextWindow = React.useMemo(() => {
    const modelId = streamState?.model ?? agentModelId ?? totalFold.lastMainModelId
    if (!modelId) return undefined
    const channel = channels.find((c) => c.id === agentChannelId)
      ?? channels.find((c) => c.models.some((m) => m.id === modelId))
    const window = channel?.models.find((m) => m.id === modelId)?.contextWindow
    return window != null && window > 0 ? window : undefined
  }, [streamState?.model, totalFold.lastMainModelId, agentModelId, channels, agentChannelId])

  const stats = React.useMemo(
    () => statsFromFold(
      totalFold,
      streamState?.inputTokens,
      streamState?.contextWindow,
      inferContextWindow,
      configuredContextWindow,
    ),
    [totalFold, streamState?.inputTokens, streamState?.contextWindow, configuredContextWindow],
  )

  // 本轮运行中：弹层里的「本轮已用」需要每秒跳动一次。
  // 定时器只在运行中开启，且状态只住在本组件，不会连带重渲染输入区。
  const runningStartedAt = streamState?.running ? streamState.startedAt : undefined
  const [nowTick, setNowTick] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (runningStartedAt == null) return
    setNowTick(Date.now())
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [runningStartedAt])
  const liveTurnElapsedMs = runningStartedAt != null
    ? Math.max(0, nowTick - runningStartedAt)
    : null

  // 无任何读数时不占位：新会话、纯失败轮次都不显示
  const hasAnyReading = stats.totalTokens > 0
    || stats.tokensPerSecond != null
    || stats.cacheHitPercent != null
    || stats.contextPercent != null
  if (embedded || !hasAnyReading) return null

  const isWarning = stats.contextTokens != null && stats.contextWindow != null
    ? stats.contextTokens / calculatePiAutoCompactionThresholdTokens(stats.contextWindow) >= WARNING_RATIO
    : false

  const hasActivityGroup = stats.turns > 0 || stats.steps > 0 || stats.tokensPerSecond != null
  const hasUsageGroup = stats.totalTokens > 0 || stats.cacheHitPercent != null

  const compactThreshold = stats.contextWindow != null
    ? calculatePiAutoCompactionThresholdTokens(stats.contextWindow)
    : null
  const tokensPerSecondText = (value: number | null | undefined): string => (
    value != null ? `${formatTokensPerSecond(value)} tok/s` : '暂无有效计时'
  )

  const activityRows: DetailRowItem[] = [
    { label: '会话平均速度', value: tokensPerSecondText(stats.tokensPerSecond), emphasized: stats.tokensPerSecond != null },
    { label: '最新轮次速度', value: tokensPerSecondText(stats.latestTokensPerSecond), emphasized: stats.latestTokensPerSecond != null },
    { label: '模型用时', value: formatStatDuration(stats.modelDurationMs) },
    {
      label: '工具调用用时',
      // 本轮尚未结束且此前没有已完成轮次时，说「本轮进行中」比「暂无」准确：
      // 计时还没结算，不是没有数据。
      value: stats.toolDurationMs != null
        ? formatStatDuration(stats.toolDurationMs)
        : liveTurnElapsedMs != null
          ? '本轮进行中'
          : '暂无',
    },
    ...(liveTurnElapsedMs != null
      ? [{ label: '本轮已用', value: formatStatDuration(liveTurnElapsedMs), emphasized: true }]
      : []),
    { label: '首 token 平均（TTFT）', value: formatStatDuration(stats.averageTtftMs) },
  ]

  const usageRows: DetailRowItem[] = [
    {
      label: '缓存命中率',
      value: stats.cacheHitPercent != null ? `${stats.cacheHitPercent}%` : '暂无',
      emphasized: stats.cacheHitPercent != null,
    },
    { label: '未缓存输入', value: `${formatCompactTokens(stats.uncachedInputTokens ?? 0)} tok` },
    { label: '缓存读取', value: `${formatCompactTokens(totalFold.cacheReadTokens)} tok` },
    { label: '输出', value: `${formatCompactTokens(totalFold.outputTokens)} tok` },
    { label: '合计', value: `${formatCompactTokens(stats.totalTokens)} tok`, emphasized: true },
  ]

  const contextRows: DetailRowItem[] = [
    {
      label: '已用',
      value: stats.contextTokens != null ? `${formatCompactTokens(stats.contextTokens)} tok` : '暂无',
      emphasized: true,
    },
    {
      label: '窗口',
      value: stats.contextWindow != null ? `${formatCompactTokens(stats.contextWindow)} tok` : '未知',
    },
    {
      label: '自动压缩阈值',
      value: compactThreshold != null ? `${formatCompactTokens(compactThreshold)} tok` : '未知',
    },
    {
      label: '剩余',
      value: stats.contextTokens != null && stats.contextWindow != null
        ? `${formatCompactTokens(Math.max(0, stats.contextWindow - stats.contextTokens))} tok`
        : '未知',
    },
  ]

  return (
    <div
      className={cn(
        // 水平居中 + 垂直居中：items-center 让文字与图标同轴线，
        // pt-[11px] 把整行从输入框底边再往下推一点（比原来的 pt-2 多 3px），读起来不贴框。
        'flex items-center justify-center gap-x-2 px-3 pt-[11px] pb-1 text-[12px] leading-none select-none',
        className,
      )}
      data-session-stats-bar={sessionId}
    >
      {hasActivityGroup && (
        <StatPill
          icon={<Gauge className="size-3" strokeWidth={2} />}
          detail={
            <DetailPanel
              icon={<Gauge className="size-3.5" strokeWidth={2} />}
              title="会话统计"
              value={`${stats.turns} 轮 ${stats.steps} 步`}
              rows={activityRows}
            />
          }
        >
          {(stats.turns > 0 || stats.steps > 0) && (
            <span>
              {stats.turns > 0 && <Value value={String(stats.turns)} unit="轮" />}
              {stats.turns > 0 && stats.steps > 0 && <Sep />}
              {stats.steps > 0 && <Value value={String(stats.steps)} unit="步" />}
            </span>
          )}
          {stats.tokensPerSecond != null && (
            <>
              {(stats.turns > 0 || stats.steps > 0) && <Sep />}
              <Value value={formatTokensPerSecond(stats.tokensPerSecond)} unit="tok/s" />
            </>
          )}
        </StatPill>
      )}

      {hasUsageGroup && (
        <StatPill
          icon={<Database className="size-3" strokeWidth={2} />}
          detail={
            <DetailPanel
              icon={<Database className="size-3.5" strokeWidth={2} />}
              title="Token 用量"
              value={`${formatCompactTokens(stats.totalTokens)} tok`}
              rows={usageRows}
            />
          }
        >
          {stats.totalTokens > 0 && (
            <Value value={formatCompactTokens(stats.totalTokens)} unit="tok" />
          )}
          {stats.totalTokens > 0 && stats.cacheHitPercent != null && <Sep />}
          {stats.cacheHitPercent != null && (
            <span>
              <span className="text-foreground/60">缓存命中</span>
              <span className="ml-1 font-medium text-foreground/90">{stats.cacheHitPercent}%</span>
            </span>
          )}
        </StatPill>
      )}

      {stats.contextPercent != null && (
        <StatPill
          icon={
            <ContextRing
              ratio={(stats.contextPercent ?? 0) / 100}
              isWarning={isWarning}
            />
          }
          detail={
            <DetailPanel
              icon={<ContextRing ratio={(stats.contextPercent ?? 0) / 100} isWarning={isWarning} />}
              title={`上下文已用 ${stats.contextPercent}%`}
              value={stats.contextTokens != null && stats.contextWindow != null
                ? `~${formatCompactTokens(stats.contextTokens)} / ${formatCompactTokens(stats.contextWindow)}`
                : undefined}
              rows={contextRows}
              note="接近自动压缩阈值时，Proma 会自动压缩上下文。"
              extra={
                <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-300',
                      isWarning ? 'bg-amber-500' : 'bg-foreground/60',
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, stats.contextPercent ?? 0))}%` }}
                  />
                </div>
              }
            />
          }
        >
          <span className={isWarning ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-foreground/90'}>
            {stats.contextPercent}%
          </span>
        </StatPill>
      )}
    </div>
  )
}

/**
 * 上下文占用小圆环 —— 与 ContextUsageBadge 同形制（描边进度环），
 * 让状态栏的百分比自带进度感而不只是一个孤立数字。
 */
function ContextRing({ ratio, isWarning }: { ratio: number; isWarning: boolean }): React.ReactElement {
  const radius = 5
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      className={cn(
        'shrink-0',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-foreground/55',
      )}
      aria-hidden
    >
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.6" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform="rotate(-90 7 7)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}
