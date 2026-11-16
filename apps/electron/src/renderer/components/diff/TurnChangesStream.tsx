/**
 * TurnChangesStream — 连续改动流。
 *
 * 按时间把每轮 Agent 文件改动连成一条流；相邻轮次间隔超过 10 分钟时折叠成
 * 可展开的「更早」区间。用户点击文件才会调用 openPreviewInStore 打开右侧
 * 工作区，组件本身绝不自动展开或切换用户当前 Tab。
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { TurnChangeEntry, TurnChangeStatus, TurnChangesSnapshot } from '@proma/shared'
import { EMPTY_CHANGES_VIEW, changesViewStatesAtom, updateChangesViewAtom } from '@/atoms/changes-view-state'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  buildTurnStreamSections,
  countTurnChanges,
  filterTurnChanges,
  getTurnChangeStatusMeta,
  joinRootAndPath,
  type TurnStreamSection,
  type TurnStreamTurnItem,
} from '@/lib/turn-changes-view'
import { openPreviewInStore } from './preview-opener'

interface TurnChangesStreamProps {
  sessionId: string
  sessionPath?: string
  turns: TurnChangesSnapshot[]
  selectedFilePath?: string
  searchQuery: string
  /** 浏览状态 key，与 DiffChangesList 的其他浏览状态保持一致。 */
  viewKey: string
}

const STATUS_TONE_CLASS: Record<TurnChangeStatus, string> = {
  created: 'text-emerald-600 dark:text-emerald-400',
  modified: 'text-amber-600 dark:text-amber-400',
  deleted: 'text-red-600 dark:text-red-400',
}

const TURN_STATUS_CLASS: Record<TurnStreamTurnItem['statusTone'], string> = {
  default: 'text-muted-foreground/70',
  stopped: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
}

export function TurnChangesStream({
  sessionId,
  sessionPath,
  turns,
  selectedFilePath,
  searchQuery,
  viewKey,
}: TurnChangesStreamProps): React.ReactElement | null {
  const views = useAtomValue(changesViewStatesAtom)
  const updateView = useSetAtom(updateChangesViewAtom)
  const store = useStore()
  const view = views.get(viewKey) ?? EMPTY_CHANGES_VIEW
  const contentId = React.useId()

  const visibleTurns = React.useMemo(() => filterTurnChanges(turns, searchQuery), [turns, searchQuery])
  const sections = React.useMemo(() => buildTurnStreamSections(visibleTurns), [visibleTurns])
  const totals = React.useMemo(() => countTurnChanges(visibleTurns), [visibleTurns])

  const handleOpenEntry = React.useCallback((entry: TurnChangeEntry) => {
    openPreviewInStore(store, sessionId, {
      filePath: joinRootAndPath(entry.rootPath, entry.filePath),
      dirPath: sessionPath,
      gitRoot: entry.rootPath,
      baseline: 'session',
      // 二进制 / 超大 / 符号链接没有可用 diff 时退化为纯文件预览。
      ...(entry.diffAvailable ? {} : { previewOnly: true }),
    })
  }, [sessionId, sessionPath, store])

  const toggleSection = React.useCallback((sectionKey: string) => {
    const next = new Set(view.expandedTurnSections)
    if (next.has(sectionKey)) next.delete(sectionKey)
    else next.add(sectionKey)
    updateView({ key: viewKey, patch: { expandedTurnSections: next } })
  }, [updateView, view.expandedTurnSections, viewKey])

  if (sections.length === 0) return null

  const expanded = view.turnStreamExpanded
  // 最新一段排在顶部；段内也按最新轮次优先，符合右侧工作区的浏览习惯。
  const orderedSections = [...sections].reverse()
  const diffParts: string[] = []
  if (totals.additions > 0) diffParts.push(`+${totals.additions}`)
  if (totals.deletions > 0) diffParts.push(`-${totals.deletions}`)

  return (
    <div className="shrink-0 border-b border-border/40 pb-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        className="group flex min-h-9 w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-medium text-muted-foreground tabular-nums transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => updateView({ key: viewKey, patch: { turnStreamExpanded: !expanded } })}
      >
        {expanded
          ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
          : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
        <ListTree className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">连续改动流</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-muted-foreground/70">
          <span>{totals.turns} 轮 · {totals.files} 个文件</span>
          {diffParts.length > 0 && (
            <span className="flex items-center gap-1">
              {totals.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{totals.additions}</span>}
              {totals.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{totals.deletions}</span>}
            </span>
          )}
        </span>
      </button>

      <div id={contentId} hidden={!expanded}>
        {orderedSections.map((section) => (
          <StreamSection
            key={section.key}
            section={section}
            expanded={view.expandedTurnSections.has(section.key)}
            onToggle={() => toggleSection(section.key)}
            onOpenEntry={handleOpenEntry}
            selectedFilePath={selectedFilePath}
          />
        ))}
      </div>
    </div>
  )
}

function StreamSection({
  section,
  expanded,
  onToggle,
  onOpenEntry,
  selectedFilePath,
}: {
  section: TurnStreamSection
  expanded: boolean
  onToggle: () => void
  onOpenEntry: (entry: TurnChangeEntry) => void
  selectedFilePath?: string
}): React.ReactElement {
  const sectionContentId = React.useId()
  const turns = [...section.turns].reverse()

  if (section.collapsible) {
    return (
      <section className="pb-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={sectionContentId}
          className="flex min-h-8 w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground/80 tabular-nums transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onToggle}
        >
          {expanded
            ? <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            : <ChevronRight className="size-3 shrink-0" aria-hidden="true" />}
          <span>更早的 {section.turns.length} 轮改动</span>
          {section.gapLabel && <span className="text-muted-foreground/50">· {section.gapLabel}</span>}
        </button>
        <div id={sectionContentId} hidden={!expanded}>
          {turns.map((item) => (
            <TurnBlock key={item.key} item={item} onOpenEntry={onOpenEntry} selectedFilePath={selectedFilePath} />
          ))}
        </div>
      </section>
    )
  }

  return (
    <section>
      {turns.map((item) => (
        <TurnBlock key={item.key} item={item} onOpenEntry={onOpenEntry} selectedFilePath={selectedFilePath} />
      ))}
    </section>
  )
}

function TurnBlock({
  item,
  onOpenEntry,
  selectedFilePath,
}: {
  item: TurnStreamTurnItem
  onOpenEntry: (entry: TurnChangeEntry) => void
  selectedFilePath?: string
}): React.ReactElement {
  return (
    <div className="pt-1">
      <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground/70">{item.timeLabel}</span>
        <span className={cn('shrink-0', TURN_STATUS_CLASS[item.statusTone])}>{item.statusLabel}</span>
        <span className="ml-auto shrink-0 text-muted-foreground/60">{item.summary.text}</span>
      </div>
      {item.entries.map((entry) => (
        <TurnChangeRow
          key={`${item.key}:${entry.filePath}`}
          entry={entry}
          selected={selectedFilePath === joinRootAndPath(entry.rootPath, entry.filePath) || selectedFilePath === entry.filePath}
          onOpen={() => onOpenEntry(entry)}
        />
      ))}
    </div>
  )
}

function TurnChangeRow({
  entry,
  selected,
  onOpen,
}: {
  entry: TurnChangeEntry
  selected: boolean
  onOpen: () => void
}): React.ReactElement {
  const parts = entry.filePath.split('/')
  const fileName = parts.pop() || entry.filePath
  const parentPath = parts.join('/')
  const status = getTurnChangeStatusMeta(entry.status)

  return (
    <div
      role="button"
      tabIndex={0}
      title={entry.filePath}
      className={cn(
        'group/file mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-[12px] transition-colors',
        selected ? 'session-item-selected bg-primary/10' : 'hover:bg-primary/5',
      )}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
    >
      <FileTypeIcon name={fileName} isDirectory={false} size={16} />
      <span className="min-w-0 flex-1 truncate">{fileName}</span>
      {parentPath && (
        <Tooltip delayDuration={900}>
          <TooltipTrigger asChild>
            <span className="min-w-0 max-w-[40%] truncate text-[11px] text-muted-foreground/60">{parentPath}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[400px] break-all">{entry.filePath}</TooltipContent>
        </Tooltip>
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
        {entry.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{entry.deletions}</span>}
      </span>
      <span
        className={cn('w-4 shrink-0 text-right text-[11px] font-medium tabular-nums', STATUS_TONE_CLASS[status.tone])}
        aria-label={status.label}
      >
        {status.letter}
      </span>
    </div>
  )
}
