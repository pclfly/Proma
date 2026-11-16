import * as React from 'react'
import { ChevronLeft, List, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTocHeadings } from '@/hooks/useTocHeadings'
import { useScrollSpy } from '@/hooks/useScrollSpy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { shouldUseCompactToc } from './markdown-toc-layout'

interface MarkdownTocProps {
  /** 预览滚动容器，标题提取与跳转都基于它 */
  containerRef: React.RefObject<HTMLElement>
  /** 文件完整 Markdown 内容，目录从源文本生成 */
  content: string
  /** LiveMarkdown 编辑器实例，用于虚拟化文档的精确跳转 */
  editorRef?: React.RefObject<{
    scrollToPosition: (position: number) => void
    getPositionAtViewportY: (viewportY: number) => number | null
  } | null>
  /** LiveMarkdown 已完成异步初始化，可可靠执行 scrollToPosition */
  editorReady?: boolean
  /** 仅 Markdown 预览时为 true */
  enabled: boolean
  /** 在目录跳转前取消可能覆盖目标位置的延迟滚动恢复 */
  onBeforeNavigate?: () => void
  /** 用户手动折叠目录 */
  onOpenChange?: (open: boolean) => void
}

/** 计算标题相对滚动容器的 top（不依赖 offsetParent 链） */
function offsetTopWithin(node: HTMLElement, container: HTMLElement): number {
  return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

export function MarkdownTocScrollTail({ containerRef, enabled }: { containerRef: React.RefObject<HTMLElement>; enabled: boolean }): React.ReactElement | null {
  const tailRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    const tail = tailRef.current
    if (!container || !tail) return

    const update = (): void => {
      // 只补足当前滚动视口高度，让文档末尾标题可精确对齐顶部；
      // 不把固定的 100vh 写进编辑器内容或持久化滚动状态。
      tail.style.height = `${Math.max(container.clientHeight, 0)}px`
    }
    update()
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(container)
    window.addEventListener('resize', update)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef, enabled])

  if (!enabled) return null
  return <div ref={tailRef} aria-hidden="true" className="pointer-events-none w-px shrink-0" />
}

export function MarkdownToc({ containerRef, content, editorRef, editorReady, enabled, onBeforeNavigate, onOpenChange }: MarkdownTocProps): React.ReactElement | null {
  const headings = useTocHeadings(containerRef, content, enabled, !editorRef)
  const activeId = useScrollSpy(containerRef, headings, editorRef)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [compact, setCompact] = React.useState(true)
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const previouslyEnabled = React.useRef(enabled)

  React.useLayoutEffect(() => {
    const explicitlyOpened = enabled && !previouslyEnabled.current
    previouslyEnabled.current = enabled
    if (!enabled) {
      setPopoverOpen(false)
      return
    }
    // 必须观察正文和目录的共同父容器；观察正文会因目录占宽而反复切换布局。
    const layoutContainer = containerRef.current?.parentElement
    if (!layoutContainer) return
    const update = (): boolean => {
      const nextCompact = shouldUseCompactToc(layoutContainer.getBoundingClientRect().width)
      setCompact(nextCompact)
      if (!nextCompact) setPopoverOpen(false)
      return nextCompact
    }
    // 既有“显示／展开目录”入口应一步打开列表；普通 resize 不重开手动收起的浮层。
    if (update() && explicitlyOpened) setPopoverOpen(true)
    const observer = new ResizeObserver(() => { update() })
    observer.observe(layoutContainer)
    return () => observer.disconnect()
  }, [containerRef, enabled])

  // LiveMarkdown 的 imperative handle 会早于异步 ink() 初始化创建；仅 ref 存在还不能跳转。
  const navigationReady = !editorRef || editorReady === true

  React.useEffect(() => {
    if (!activeId || !listRef.current) return
    listRef.current.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId, popoverOpen, compact])

  const minLevel = React.useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings],
  )

  if (!enabled) return null

  const jumpTo = (heading: (typeof headings)[number]): void => {
    const editor = editorRef?.current
    if (editor && navigationReady) {
      onBeforeNavigate?.()
      editor.scrollToPosition(heading.position)
      setPopoverOpen(false)
      return
    }
    const container = containerRef.current
    if (!container || !heading.el) return
    onBeforeNavigate?.()
    const top = offsetTopWithin(heading.el, container)
    container.scrollTo({ top: Math.max(top - 8, 0), behavior: 'smooth' })
    setPopoverOpen(false)
  }

  const navigation = (
    <nav aria-label="文档目录" className={cn('flex min-h-0 flex-col rounded-lg', compact ? 'h-[min(60vh,420px)] w-full' : 'm-2 h-[calc(100%-1rem)] w-52 shrink-0 self-start bg-muted/40')}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <div className="min-w-0 flex-1 text-[11px] font-medium text-foreground/40 select-none">目录</div>
        {(compact || onOpenChange) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => compact ? setPopoverOpen(false) : onOpenChange?.(false)} className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/70" aria-label="收起目录">
                {compact ? <X className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">收起目录</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto scrollbar-thin px-1 pb-2">
        {headings.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">暂无标题</p>}
        {headings.map((heading) => (
          <button key={heading.id} type="button" data-toc-id={heading.id} onClick={() => jumpTo(heading)} disabled={!navigationReady} title={navigationReady ? heading.text : '正在准备目录跳转'} style={{ paddingLeft: `${(heading.level - minLevel) * 12 + 8}px` }} className={cn('block w-full text-left truncate rounded py-1 pr-2 text-[12px] leading-snug transition-colors disabled:cursor-wait disabled:opacity-50', 'border-l-2 border-transparent', heading.id === activeId ? 'border-primary text-foreground font-medium bg-foreground/[0.04]' : 'text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03]')}>
            {heading.text}
          </button>
        ))}
      </div>
    </nav>
  )

  if (!compact) return navigation
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="mx-2 mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-md bg-muted/40 text-foreground/60 hover:bg-muted" aria-label="打开文档目录" title="打开文档目录">
          <List className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-1">
        {navigation}
      </PopoverContent>
    </Popover>
  )
}
