import * as React from 'react'
import { cn } from '@/lib/utils'
import type { LiveMarkdownCallout } from './live-markdown-callout'

interface LiveMarkdownCalloutViewProps {
  callout: LiveMarkdownCallout
  bodyHtml: string
  /** 光标移入块内即恢复源码编辑，与其它块级预览一致。 */
  onRevealSource: () => void
  onOpenWikiLink?: (target: string) => void
}

/** 阅读态 Callout：外观接近 Obsidian，但不修改 Markdown 原文。 */
export function LiveMarkdownCalloutView({
  callout,
  bodyHtml,
  onRevealSource,
  onOpenWikiLink,
}: LiveMarkdownCalloutViewProps): React.ReactElement {
  const foldable = callout.fold !== null
  const [collapsed, setCollapsed] = React.useState(callout.fold === 'closed')

  React.useEffect(() => {
    setCollapsed(callout.fold === 'closed')
  }, [callout.fold, callout.title, callout.type])

  const toggleFold = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setCollapsed((previous) => !previous)
  }, [])

  const revealFromPointer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-vault-wikilink-target]') : null
    if (target) {
      const note = target.dataset.vaultWikilinkTarget
      if (!note) return
      event.preventDefault()
      event.stopPropagation()
      if (event.altKey || !onOpenWikiLink) onRevealSource()
      else onOpenWikiLink(note)
      return
    }
    // 折叠按钮已自行阻止冒泡；仅正文需要尊重拖选复制，标题始终进入编辑。
    const fromBody = event.currentTarget.classList.contains('live-markdown-callout-body')
    const selection = fromBody ? window.getSelection() : null
    if (selection && !selection.isCollapsed && selection.toString().trim()) return
    if (!onOpenWikiLink || !(event.target instanceof Element) || !event.target.closest('a')) {
      event.preventDefault()
      onRevealSource()
    }
  }, [onOpenWikiLink, onRevealSource])

  return (
    <section className={cn('live-markdown-callout', `is-${callout.kind}`)} data-callout-type={callout.type}>
      <div
        className="live-markdown-callout-heading"
        onClick={revealFromPointer}
        // 标题没有可复制正文，直接按下即进入编辑，避免 click 被编辑器宿主吞掉。
        onMouseDown={(event) => {
          if (event.target instanceof Element && event.target.closest('.live-markdown-callout-fold')) return
          event.preventDefault()
          revealFromPointer(event)
        }}
      >
        <span className="live-markdown-callout-icon" aria-hidden="true" />
        <span className="live-markdown-callout-title">{callout.title}</span>
        {foldable && (
          <button
            type="button"
            className="live-markdown-callout-fold"
            aria-label={collapsed ? '展开提示块' : '折叠提示块'}
            aria-expanded={!collapsed}
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
            onClick={toggleFold}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
      </div>
      {collapsed ? null : (
        <div
          className="live-markdown-callout-body"
          onClick={revealFromPointer}
          // 不能在 mousedown 阻止默认行为，否则正文无法拖选复制；改由 click 判断选区。
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
    </section>
  )
}
