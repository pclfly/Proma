import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildUsageTooltip } from '@/lib/turn-usage'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentEventUsage } from '@proma/shared'
import { getToolDisplayName, getToolIcon } from './tool-utils'
import type {
  SDKContentBlock,
  SDKToolUseBlock,
  SDKTextBlock,
  SDKThinkingBlock,
} from '@proma/shared'

export type AssistantTurnOutcome = 'running' | 'completed' | 'stopped' | 'failed'

interface ProcessBlockGroupProps {
  blocks: SDKContentBlock[]
  isStreaming?: boolean
  /** 本轮终态；中断/失败必须保持展开并标注，不能自动折叠。 */
  outcome?: AssistantTurnOutcome
  /** 本轮开始时间，用于流式期间显示「持续 Xs」。 */
  startedAt?: number
  /** 已完成的耗时；优先于 startedAt 推算。 */
  durationMs?: number
  /** 已完成的过程步数（工具调用数）。 */
  steps?: number
  /** 本轮 token 用量；悬浮在过程摘要上显示耗时/输入/输出。 */
  usage?: AgentEventUsage
  /** 惰性生成过程项；流式与历史态均渲染完整内容。 */
  renderChildren: () => React.ReactNode
  // 该过程组是否为整条消息的末尾项：是则流式中保留最后一段为正常显示，
  // 否则（最终答案已作为后续兄弟块外置）整组统一弱化。
  isMessageTail?: boolean
}

const MAX_PROCESS_GROUP_ICONS = 4
const PROCESS_GROUP_LIVE_CHILD_WINDOW = 4
const PROCESS_GROUP_COLLAPSE_DURATION_MS = 500
const PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS = 900
const PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3

interface IndexedContentBlock {
  block: SDKContentBlock
  index: number
}

export type AssistantTurnRenderItem =
  | { type: 'block'; item: IndexedContentBlock }
  | {
      type: 'process-group'
      items: IndexedContentBlock[]
    }

interface BuildAssistantTurnRenderItemsOptions {
  isStreaming?: boolean
}

/** OpenAI Responses 显式标记 final_answer 的文本块；优先于「末尾连续 text」启发式。 */
function getFinalAnswerStartIndex(blocks: SDKContentBlock[]): number | null {
  const index = blocks.findIndex(
    (block) => block.type === 'text' && (block as SDKTextBlock).phase === 'final_answer',
  )
  return index >= 0 ? index : null
}

function getTrailingTextStartIndex(blocks: SDKContentBlock[]): number | null {
  const lastBlock = blocks[blocks.length - 1]
  if (lastBlock?.type !== 'text') return null
  // 官方 0.22.80：显式标记为 commentary 的过程回复即使位于末尾，也不能当作最终答案；
  // 否则「我先看一下」这类过程说明会被外置成答复，而真正的答案仍在工具之后。
  if ((lastBlock as SDKTextBlock).phase === 'commentary') return null

  let finalStartIndex = blocks.length - 1
  while (finalStartIndex > 0 && blocks[finalStartIndex - 1]?.type === 'text') {
    finalStartIndex -= 1
  }
  return finalStartIndex
}

export function buildAssistantTurnRenderItems(
  blocks: SDKContentBlock[],
  options: BuildAssistantTurnRenderItemsOptions = {},
): AssistantTurnRenderItem[] {
  if (blocks.length === 0) return []

  // 最终回复必须始终留在过程组之外：
  // 1. OpenAI Responses 显式 final_answer 阶段优先；
  // 2. 其余模型退回「末尾连续 text」启发式。
  // 流式期间若 Agent 之后继续调用工具，final text 不再位于末尾，会自动回归过程组。
  const hasProcessBlock = blocks.some((block) => block.type === 'tool_use' || block.type === 'thinking')
  const finalAnswerStartIndex = getFinalAnswerStartIndex(blocks)
  const trailingTextStartIndex = getTrailingTextStartIndex(blocks)
  const splitStartIndex = finalAnswerStartIndex ?? trailingTextStartIndex
  const canSplitStreamingFinalOutput = options.isStreaming
    && hasProcessBlock
    && splitStartIndex !== null
    && splitStartIndex > 0

  if (options.isStreaming && hasProcessBlock && !canSplitStreamingFinalOutput) {
    return buildProcessGroupItems(blocks)
  }

  if (splitStartIndex === null) {
    return buildProcessGroupItems(blocks)
  }

  const items: AssistantTurnRenderItem[] = []
  if (splitStartIndex > 0) {
    items.push(...buildProcessGroupItems(
      blocks.slice(0, splitStartIndex),
    ))
  }

  for (let index = splitStartIndex; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    items.push({ type: 'block', item: { block, index } })
  }

  return items
}

function buildProcessGroupItems(blocks: SDKContentBlock[]): AssistantTurnRenderItem[] {
  return [{
    type: 'process-group',
    items: blocks.map((block, index) => ({ block, index })),
  }]
}

export interface NestedThinkingBlock {
  block: SDKContentBlock
  index: number
}

export interface NestedProcessItem {
  block: SDKContentBlock
  index: number
  nestedThinking: NestedThinkingBlock[]
}

/**
 * 命令/工具行吸收紧随其后的连续思考块：展开工具行时在缩进区一并显示。
 * 流式中的最后一段思考保持独立，避免「正在分析」被收进工具行后不可见。
 */
export function buildNestedProcessItems(
  items: ReadonlyArray<{ block: SDKContentBlock; index: number }>,
  options: { keepTailStandalone?: boolean } = {},
): NestedProcessItem[] {
  const keepIndex = options.keepTailStandalone ? items[items.length - 1]?.index : undefined
  const result: NestedProcessItem[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.block.type !== 'tool_use') {
      result.push({ ...item, nestedThinking: [] })
      continue
    }

    const nestedThinking: NestedThinkingBlock[] = []
    let next = i + 1
    while (
      next < items.length
      && items[next]!.block.type === 'thinking'
      && items[next]!.index !== keepIndex
    ) {
      nestedThinking.push(items[next]!)
      next += 1
    }
    result.push({ ...item, nestedThinking })
    i = next - 1
  }

  return result
}

/** 过程摘要里的耗时使用中文单位，与截图的「5 分 52 秒」一致。 */
export function formatProcessDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
}

export interface ProcessSummaryInput {
  outcome: AssistantTurnOutcome
  /** 已结束轮次的耗时。 */
  durationMs?: number
  /** 流式期间实时耗时。 */
  liveDurationMs?: number
  /** 已完成的工具步数。 */
  steps?: number
}

/**
 * 过程摘要：一行终态文案。
 * - 运行中：正在执行任务 · 已完成 3 步 · 持续 12 秒
 * - 已完成，用时 1 分 5 秒 · 6 步
 * - 已停止 / 运行失败
 */
export function buildProcessSummaryText({
  outcome,
  durationMs,
  liveDurationMs,
  steps,
}: ProcessSummaryInput): string {
  if (outcome === 'running') {
    const parts = ['正在执行任务']
    if (steps !== undefined && steps > 0) parts.push(`已完成 ${steps} 步`)
    if (liveDurationMs !== undefined && liveDurationMs >= 0) {
      parts.push(`持续 ${formatProcessDuration(liveDurationMs)}`)
    }
    return parts.join(' · ')
  }

  if (outcome === 'stopped') return '已停止'
  if (outcome === 'failed') return '运行失败'

  const base = durationMs !== undefined
    ? `已完成，用时 ${formatProcessDuration(durationMs)}`
    : '已完成'
  return steps !== undefined && steps > 1 ? `${base} · ${steps} 步` : base
}

function countProcessSteps(blocks: SDKContentBlock[]): number {
  return blocks.reduce((count, block) => count + (block.type === 'tool_use' ? 1 : 0), 0)
}

export function buildProcessGroupToolNames(blocks: SDKContentBlock[]): string[] {
  const toolNames: string[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const toolBlock = block as SDKToolUseBlock
    if (seen.has(toolBlock.name)) continue
    seen.add(toolBlock.name)
    toolNames.push(toolBlock.name)
  }

  return toolNames
}

type ProcessGroupDisplayMode = 'collapsed' | 'expanded'

function getProcessChildKey(child: React.ReactNode, index: number): string {
  if (React.isValidElement(child) && child.key != null) return String(child.key)
  return `process-child-${index}`
}

interface StableProcessChildCacheEntry {
  child: React.ReactNode
  snapshot: string
}

function getProcessChildSnapshot(child: React.ReactNode): string | null {
  if (!React.isValidElement(child) || child.type !== React.Fragment) return null
  const fragmentProps = child.props as { children?: React.ReactNode }
  const content = fragmentProps.children
  if (!React.isValidElement(content)) return null
  const contentProps = content.props as { block?: SDKContentBlock }
  const block = contentProps.block
  if (!block || (block.type !== 'text' && block.type !== 'thinking')) return null
  const text = block.type === 'text'
    ? (block as SDKTextBlock).text
    : (block as SDKThinkingBlock).thinking
  return `${block.type}:${text}`
}

const StableProcessChild = React.memo(
  function StableProcessChild({ child }: { child: React.ReactNode }): React.ReactElement {
    return <>{child}</>
  },
  (previous, next) => previous.child === next.child,
)

export function ProcessBlockGroup({
  blocks,
  isStreaming,
  outcome,
  startedAt,
  durationMs,
  steps,
  usage,
  renderChildren,
  isMessageTail = false,
}: ProcessBlockGroupProps): React.ReactElement {
  const turnOutcome: AssistantTurnOutcome = outcome ?? (isStreaming ? 'running' : 'completed')
  // 中断/失败轮次必须保持展开并标注，不能被自动折叠吞掉。
  const isTerminalOpen = turnOutcome === 'stopped' || turnOutcome === 'failed'
  const initialDisplayMode: ProcessGroupDisplayMode = !isStreaming && !isTerminalOpen
    ? 'collapsed'
    : 'expanded'
  const [displayMode, setDisplayMode] = React.useState<ProcessGroupDisplayMode>(initialDisplayMode)
  const [shouldRenderContent, setShouldRenderContent] = React.useState(initialDisplayMode !== 'collapsed')
  const [collapseCountdown, setCollapseCountdown] = React.useState<number | null>(null)
  const userToggledRef = React.useRef(false)
  const wasStreamingRef = React.useRef(!!isStreaming)
  const autoCollapseTimersRef = React.useRef<number[]>([])
  const contentRef = React.useRef<HTMLDivElement>(null)
  const stableChildrenRef = React.useRef(new Map<string, StableProcessChildCacheEntry>())
  const collapseFrameRef = React.useRef<number | null>(null)
  const [measuredHeight, setMeasuredHeight] = React.useState<number | undefined>(undefined)

  const isContentExpanded = displayMode === 'expanded'
  const shouldShowContent = isContentExpanded || shouldRenderContent
  const visibleChildren = shouldShowContent ? renderChildren() : null

  const clearAutoCollapseTimers = React.useCallback(() => {
    for (const timer of autoCollapseTimersRef.current) window.clearTimeout(timer)
    autoCollapseTimersRef.current = []
  }, [])

  React.useEffect(() => {
    clearAutoCollapseTimers()

    if (isTerminalOpen) {
      setCollapseCountdown(null)
      setDisplayMode('expanded')
      wasStreamingRef.current = false
      return clearAutoCollapseTimers
    }

    if (isStreaming) {
      setCollapseCountdown(null)
      if (!wasStreamingRef.current) userToggledRef.current = false
      if (!userToggledRef.current) setDisplayMode('expanded')
      wasStreamingRef.current = true
      return
    }

    const shouldAutoCollapseAfterCompletion = wasStreamingRef.current && !userToggledRef.current
    wasStreamingRef.current = false

    if (!shouldAutoCollapseAfterCompletion) {
      if (!userToggledRef.current) setDisplayMode('collapsed')
      return
    }

    const soundDelayTimer = window.setTimeout(() => {
      setCollapseCountdown(PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS)

      for (let second = PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - 1; second >= 1; second--) {
        const elapsed = (PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - second) * 1000
        autoCollapseTimersRef.current.push(window.setTimeout(() => setCollapseCountdown(second), elapsed))
      }

      autoCollapseTimersRef.current.push(window.setTimeout(() => {
        setCollapseCountdown(null)
        setDisplayMode('collapsed')
      }, PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS * 1000))
    }, PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS)
    autoCollapseTimersRef.current.push(soundDelayTimer)

    return clearAutoCollapseTimers
  }, [clearAutoCollapseTimers, isStreaming, isTerminalOpen])

  // 折叠前测量实际高度，用于丝滑的 height 过渡（子元素不 reflow，只裁剪边界）
  React.useEffect(() => {
    if (isContentExpanded) {
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
      setShouldRenderContent(true)
      setMeasuredHeight(undefined)
      return
    }

    // 折叠时：先测量当前高度，触发 height 过渡动画，动画结束后卸载 DOM
    const el = contentRef.current
    if (el) {
      const h = el.clientHeight
      setMeasuredHeight(h)
      collapseFrameRef.current = requestAnimationFrame(() => {
        collapseFrameRef.current = null
        setMeasuredHeight(0)
      })
    }

    const timer = window.setTimeout(() => setShouldRenderContent(false), PROCESS_GROUP_COLLAPSE_DURATION_MS)
    return () => {
      window.clearTimeout(timer)
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
    }
  }, [isContentExpanded])

  const stepCount = steps ?? countProcessSteps(blocks)
  const [liveDurationMs, setLiveDurationMs] = React.useState<number | undefined>(undefined)

  React.useEffect(() => {
    if (!isStreaming || turnOutcome !== 'running' || startedAt === undefined) {
      setLiveDurationMs(undefined)
      return
    }
    const update = (): void => setLiveDurationMs(Math.max(0, Date.now() - startedAt))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming, startedAt, turnOutcome])

  const summary = React.useMemo(
    () => buildProcessSummaryText({
      outcome: turnOutcome,
      durationMs,
      liveDurationMs,
      steps: stepCount,
    }),
    [durationMs, liveDurationMs, stepCount, turnOutcome],
  )
  const summaryClassName = cn(
    'min-w-0 truncate text-[14px]',
    turnOutcome === 'failed'
      ? 'text-red-600/80 dark:text-red-400/80'
      : turnOutcome === 'stopped'
        ? 'text-amber-600/80 dark:text-amber-400/80'
        : 'text-muted-foreground',
  )
  const toolNames = React.useMemo(() => buildProcessGroupToolNames(blocks), [blocks])
  const visibleToolNames = toolNames.slice(0, MAX_PROCESS_GROUP_ICONS)
  const hiddenToolCount = Math.max(0, toolNames.length - visibleToolNames.length)

  // 只让最近几项参与高频更新；旧项保留在 DOM 中供用户滚动查看，但冻结其 React 子树。
  const renderContentChildren = (): React.ReactNode => {
    const childArray = React.Children.toArray(visibleChildren)
    const liveStart = Math.max(0, childArray.length - PROCESS_GROUP_LIVE_CHILD_WINDOW)
    const activeKeys = new Set<string>()

    const rendered = childArray.map((child, i) => {
      const key = getProcessChildKey(child, i)
      activeKeys.add(key)
      const cachedEntry = stableChildrenRef.current.get(key)
      const snapshot = getProcessChildSnapshot(child)
      const shouldFreeze = !!isStreaming && i < liveStart && snapshot !== null
      const stableChild = shouldFreeze && cachedEntry?.snapshot === snapshot
        ? cachedEntry.child
        : child
      if (!shouldFreeze || !cachedEntry || cachedEntry.snapshot !== snapshot) {
        stableChildrenRef.current.set(key, { child, snapshot: snapshot ?? '' })
      }

      const isLast = i === childArray.length - 1
      const dimmed = isStreaming && !(isMessageTail && isLast)
      return (
        <div key={key} className={cn(dimmed && 'opacity-80')}>
          <StableProcessChild child={stableChild} />
        </div>
      )
    })

    for (const key of stableChildrenRef.current.keys()) {
      if (!activeKeys.has(key)) stableChildrenRef.current.delete(key)
    }
    return rendered
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={isTerminalOpen}
        className={cn(
          'flex max-w-full items-center gap-2 py-0.5 text-left transition-opacity group',
          isTerminalOpen ? 'cursor-default' : 'hover:opacity-70',
        )}
        onClick={() => {
          if (isTerminalOpen) return
          userToggledRef.current = true
          clearAutoCollapseTimers()
          setCollapseCountdown(null)
          setDisplayMode((previous) => previous === 'collapsed' ? 'expanded' : 'collapsed')
        }}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/40 transition-transform duration-150',
            isContentExpanded && 'rotate-90',
          )}
        />
        {turnOutcome === 'completed' && durationMs !== undefined ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={summaryClassName}>{summary}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="whitespace-pre-line text-left">{buildUsageTooltip(durationMs, usage)}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className={summaryClassName}>{summary}</span>
        )}
        {collapseCountdown !== null && (
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground/50">
            （{collapseCountdown}）
          </span>
        )}
        {visibleToolNames.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground/60">
            {visibleToolNames.map((toolName) => {
              const ToolIcon = getToolIcon(toolName)
              return (
                <ToolIcon
                  key={toolName}
                  className="size-3.5"
                  aria-label={getToolDisplayName(toolName)}
                />
              )
            })}
            {hiddenToolCount > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground/60">
                +{hiddenToolCount}
              </span>
            )}
          </span>
        )}
      </button>

      {shouldRenderContent && (
        <div
          ref={contentRef}
          data-agent-history-selection-excluded={isContentExpanded ? undefined : 'true'}
          className="overflow-hidden focus:outline-none"
          style={{
            height: measuredHeight !== undefined ? `${measuredHeight}px` : 'auto',
            opacity: isContentExpanded ? 1 : 0,
            transition: measuredHeight !== undefined
              ? `height ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`
              : `opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`,
          }}
        >
          {/* 摘要下分隔线 + 平铺过程流：思考、工具、旁白按执行顺序连续展示，不再套限高滚动框。 */}
          <div className="mt-2 space-y-2 border-t border-border/40 pt-2.5">
            {renderContentChildren()}
          </div>
        </div>
      )}
    </div>
  )
}
