/**
 * 收藏会话（官方 0.22.0 左侧栏「收藏会话」入口）。
 *
 * 搜索与列表在分区侧栏；主区只保留空状态说明，点击会话后进入对话视图。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Archive, ChevronDown, Search, Star } from 'lucide-react'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getAgentSessionActivityTime } from '@/lib/agent-session-list'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type StarredSortMode = 'starred' | 'activity' | 'project'
type StarredViewMode = 'active' | 'archived'

const SORT_LABELS: Record<StarredSortMode, string> = {
  starred: '收藏时间',
  activity: '最新活跃',
  project: '项目',
}

export function StarredSectionSidebar(): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const setSessions = useSetAtom(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const openSession = useOpenSession()
  const [query, setQuery] = React.useState('')
  const [sortBy, setSortBy] = React.useState<StarredSortMode>('starred')
  const [viewMode, setViewMode] = React.useState<StarredViewMode>('active')
  const archivedView = viewMode === 'archived'

  // 归档会话默认不进入轻量 active 列表；切到已归档收藏时按需补载归档元数据。
  React.useEffect(() => {
    if (!archivedView) return
    let cancelled = false
    void window.electronAPI.listArchivedAgentSessions()
      .then((archived) => {
        if (cancelled) return
        setSessions((current) => {
          const merged = new Map(current.map((session) => [session.id, session]))
          for (const session of archived) merged.set(session.id, session)
          return [...merged.values()]
        })
      })
      .catch((error) => {
        console.error('[收藏会话] 读取归档会话失败:', error)
      })
    return () => { cancelled = true }
  }, [archivedView, setSessions])

  const workspaceNameById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  )

  const starred = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return sessions
      .filter((session) => session.starred && !session.isDraft)
      // 已归档收藏单独成组，避免同一会话同时出现在两个列表里。
      .filter((session) => archivedView ? session.archived === true : session.archived !== true)
      .filter((session) => !normalized || session.title.toLowerCase().includes(normalized))
      .slice()
      .sort((a, b) => {
        if (sortBy === 'project') {
          const aName = a.workspaceId ? workspaceNameById.get(a.workspaceId) ?? '' : ''
          const bName = b.workspaceId ? workspaceNameById.get(b.workspaceId) ?? '' : ''
          return aName.localeCompare(bName, 'zh-CN')
            || getAgentSessionActivityTime(b) - getAgentSessionActivityTime(a)
        }
        if (sortBy === 'activity') return getAgentSessionActivityTime(b) - getAgentSessionActivityTime(a)
        // 旧会话没有 starredAt：回退到更新时间，避免整组乱序。
        return (b.starredAt ?? b.updatedAt ?? b.createdAt) - (a.starredAt ?? a.updatedAt ?? a.createdAt)
      })
  }, [archivedView, query, sessions, sortBy, workspaceNameById])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/50 p-3">
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          {archivedView
            ? '已归档的收藏会话会保留在这里，随时可以恢复处理。'
            : '点击星标即可收藏会话，方便回顾和后续处理重要事务。'}
        </p>
        <label className="flex h-8 items-center gap-2 rounded-md bg-muted/50 px-2 text-xs text-muted-foreground">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={archivedView ? '搜索已归档收藏' : '搜索收藏'}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </label>
        <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="收藏会话排序"
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                排序：{SORT_LABELS[sortBy]}
                <ChevronDown size={12} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[100] w-40">
              {(Object.keys(SORT_LABELS) as StarredSortMode[]).map((mode) => (
                <DropdownMenuItem
                  key={mode}
                  onSelect={() => setSortBy(mode)}
                  className={cn(sortBy === mode && 'bg-accent text-accent-foreground')}
                >
                  按{SORT_LABELS[mode]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {starred.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {archivedView ? '还没有已归档的收藏' : '还没有收藏会话'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {starred.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => openSession('agent', session.id, session.title)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground/85 transition-colors',
                  'hover:bg-muted/60',
                )}
              >
                <Star size={12} className="shrink-0 fill-primary/20 text-primary/70" />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {session.workspaceId && workspaceNameById.get(session.workspaceId) && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {workspaceNameById.get(session.workspaceId)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 页面内切换「已归档收藏」，不跳转到会话侧栏的归档视图。 */}
      <div className="shrink-0 border-t border-border/50 p-2">
        <button
          type="button"
          onClick={() => setViewMode(archivedView ? 'active' : 'archived')}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {archivedView ? <Star size={13} /> : <Archive size={13} />}
          <span>{archivedView ? '返回收藏会话' : '已归档'}</span>
        </button>
      </div>
    </div>
  )
}

export function StarredSessionsView(): React.ReactElement {
  return (
    <section className="flex h-full min-h-0 items-center justify-center bg-background px-10 text-center">
      <div className="max-w-md space-y-1 text-sm text-muted-foreground">
        <p>从左侧选择收藏会话，继续工作。</p>
        <p>你也可以在会话菜单中添加收藏，方便随时回来。</p>
      </div>
    </section>
  )
}
