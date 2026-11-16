import * as React from 'react'
import { ArchiveRestore, ChevronDown, GitBranch, RotateCw, SquareTerminal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { WorktreeInfo, WorkspaceWorktreeRepo } from '@proma/shared'
import { normalizePathForCompare } from '@proma/shared'

interface WorktreeSelectorProps {
  sessionId: string
  workspaceSlug?: string
  repoPaths?: string[]
  selectedPath: string | null
  onSelect: (worktree: WorktreeInfo | null) => void
  onOpenTerminal?: (worktree: WorktreeInfo) => void
}

interface RepoWorktrees {
  repo: WorkspaceWorktreeRepo
  worktrees: WorktreeInfo[]
}

function normalizePathKey(filePath: string): string {
  return normalizePathForCompare(filePath)
}

function getPathBasename(filePath: string): string {
  return normalizePathKey(filePath).split('/').filter(Boolean).pop() || filePath
}

export function WorktreeSelector({
  sessionId,
  workspaceSlug,
  repoPaths,
  selectedPath,
  onSelect,
  onOpenTerminal,
}: WorktreeSelectorProps): React.ReactElement {
  const [repoWorktrees, setRepoWorktrees] = React.useState<RepoWorktrees[]>([])
  const [isOpen, setIsOpen] = React.useState(false)
  // 初次挂载即保留工具栏高度，避免切回「改动」Tab 后选择器异步出现而推挤文件列表。
  const [isLoading, setIsLoading] = React.useState(true)
  const [pendingRemoval, setPendingRemoval] = React.useState<{ worktree: WorktreeInfo; repoPath: string } | null>(null)
  const [isRemoving, setIsRemoving] = React.useState(false)
  const [restorable, setRestorable] = React.useState<Array<{ path: string; branch?: string; repositoryRoot?: string; recordedAt: number }>>([])
  const [pendingRestore, setPendingRestore] = React.useState<{ path: string; branch?: string } | null>(null)
  const [isRestoring, setIsRestoring] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)
  /** 丢弃较早请求的迟到响应，避免手动刷新后回滚到旧 Worktree 列表。 */
  const fetchSequenceRef = React.useRef(0)

  const fetchWorktrees = React.useCallback(async () => {
    const requestId = ++fetchSequenceRef.current
    setIsLoading(true)
    try {
      const repoMap = new Map<string, WorkspaceWorktreeRepo>()

      if (workspaceSlug) {
        const repos = await window.electronAPI.getWorktreeRepos(workspaceSlug)
        for (const repo of repos) {
          repoMap.set(normalizePathKey(repo.repoPath), repo)
        }
      }

      for (const repoPath of repoPaths ?? []) {
        if (!repoPath) continue
        const key = normalizePathKey(repoPath)
        if (repoMap.has(key)) continue
        repoMap.set(key, {
          name: getPathBasename(repoPath),
          repoPath,
          worktreesPath: '',
          priority: 0,
        })
      }

      const repos = Array.from(repoMap.values())
      if (repos.length === 0) {
        if (requestId === fetchSequenceRef.current) setRepoWorktrees([])
        return
      }

      const results: RepoWorktrees[] = []
      for (const repo of repos) {
        try {
          const list = await window.electronAPI.listWorktrees(repo.repoPath, sessionId)
          const nonMain = list.filter((wt) => !wt.isMain)
          if (nonMain.length > 0) {
            results.push({ repo, worktrees: nonMain })
          }
        } catch {
          // 跳过当前会话无权读取或已失效的仓库。
        }
      }
      if (requestId === fetchSequenceRef.current) setRepoWorktrees(results)
    } catch {
      if (requestId === fetchSequenceRef.current) setRepoWorktrees([])
    } finally {
      if (requestId === fetchSequenceRef.current) setIsLoading(false)
    }
  }, [workspaceSlug, repoPaths, sessionId])

  React.useEffect(() => {
    fetchWorktrees()
  }, [fetchWorktrees])

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const fetchRestorable = React.useCallback(async () => {
    try {
      // 只读取已失效的检出历史；不触发 Git 写操作。
      const list = await window.electronAPI.getRestorableWorktrees(sessionId)
      setRestorable(list.map((entry) => ({
        path: entry.path,
        branch: entry.branch,
        repositoryRoot: entry.repositoryRoot,
        recordedAt: entry.recordedAt,
      })))
    } catch {
      setRestorable([])
    }
  }, [sessionId])

  React.useEffect(() => {
    void fetchRestorable()
  }, [fetchRestorable])

  const confirmRestoreWorktree = React.useCallback(async (): Promise<void> => {
    const target = pendingRestore
    if (!target) return
    setIsRestoring(true)
    try {
      const restored = await window.electronAPI.restoreWorktree({ sessionId, path: target.path, confirmed: true })
      toast.success(`已恢复 Worktree：${restored.branch ?? target.branch ?? ''}`)
      await fetchWorktrees()
      await fetchRestorable()
      setPendingRestore(null)
      const next = await window.electronAPI.listWorktrees(restored.path, sessionId).catch(() => [])
      const match = next.find((wt) => normalizePathKey(wt.path) === normalizePathKey(restored.path))
      if (match) onSelect(match)
    } catch (error) {
      console.error('[Worktree] 恢复失败:', error)
      toast.error(error instanceof Error ? error.message : '恢复 Worktree 失败')
    } finally {
      setIsRestoring(false)
    }
  }, [pendingRestore, sessionId, fetchWorktrees, fetchRestorable, onSelect])

  const allWorktrees = repoWorktrees.flatMap((rw) => rw.worktrees)
  const confirmRemoveWorktree = React.useCallback(async (): Promise<void> => {
    const target = pendingRemoval
    if (!target) return
    setIsRemoving(true)
    try {
      const result = await window.electronAPI.removeWorktree({
        repoPath: target.repoPath,
        worktreePath: target.worktree.path,
        sessionId,
        confirmed: true,
      })
      if (result.removed) {
        if (selectedPath && normalizePathKey(selectedPath) === normalizePathKey(target.worktree.path)) {
          onSelect(null)
        }
        toast.success(`已删除 Worktree：${target.worktree.branch}`)
        await fetchWorktrees()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除 Worktree 失败')
    } finally {
      setIsRemoving(false)
      setPendingRemoval(null)
    }
  }, [fetchWorktrees, onSelect, pendingRemoval, selectedPath, sessionId])

  const selectedWorktree = allWorktrees.find((wt) => normalizePathKey(wt.path) === normalizePathKey(selectedPath ?? ''))
  const hasMultipleRepos = repoWorktrees.length > 1

  if (allWorktrees.length === 0 && !isLoading) return <></>

  return (
    <div ref={dropdownRef} className="relative shrink-0 border-b border-border/60 bg-content-area px-2 py-2">
      <div className="flex items-center gap-1.5">
        {allWorktrees.length === 0 ? (
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/45 px-2.5" aria-busy="true">
            <div className="size-3.5 shrink-0 rounded bg-muted-foreground/15 animate-pulse" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="h-2.5 w-28 rounded bg-muted-foreground/15 animate-pulse" />
              <div className="h-2 w-16 rounded bg-muted-foreground/10 animate-pulse" />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/45 px-2.5 py-1.5 text-left transition-[background-color,color] hover:bg-muted/75',
              selectedWorktree ? 'text-foreground' : 'text-muted-foreground',
            )}
            aria-expanded={isOpen}
          >
            <GitBranch className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium leading-4">
                {selectedWorktree?.branch ?? '选择开发 Worktree'}
              </span>
              <span className="block truncate text-[10px] leading-3 text-muted-foreground">
                {selectedWorktree ? getPathBasename(selectedWorktree.path) : '会话改动'}
              </span>
            </span>
            <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
          </button>
        )}
        {allWorktrees.length === 0 && selectedPath && onOpenTerminal && (
          <span className="inline-flex size-9 shrink-0 items-center justify-center text-muted-foreground/30" aria-hidden="true">
            <SquareTerminal className="size-4 animate-pulse" />
          </span>
        )}
        {selectedWorktree && onOpenTerminal && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpenTerminal(selectedWorktree)}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
                aria-label={`在 ${selectedWorktree.branch} 打开终端`}
              >
                <SquareTerminal className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">在右侧标签中打开终端</TooltipContent>
          </Tooltip>
        )}
        <button
          type="button"
          onClick={() => void fetchWorktrees()}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
          title="刷新 Worktree 列表"
          aria-label="刷新 Worktree 列表"
        >
          <RotateCw className={cn('size-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>

      {isOpen && (
        <div className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg" aria-label="开发 Worktree">
          <button
            type="button"
            onClick={() => {
              onSelect(null)
              setIsOpen(false)
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent/60',
              !selectedPath && 'bg-accent/45 font-medium',
            )}
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block leading-4">会话改动</span>
              <span className="block truncate text-[10px] leading-3 text-muted-foreground">显示此会话直接产生的改动</span>
            </span>
          </button>
          <div className="my-1 h-px bg-border/70" />
          {restorable.length > 0 && (
            <div className="border-b border-border/60 pb-1">
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                已移除的检出
              </div>
              {restorable.map((entry) => (
                <div key={entry.path} className="group flex items-center gap-1 rounded-lg">
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs">
                    <ArchiveRestore className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium leading-4">{entry.branch ?? '未知分支'}</span>
                      <span className="block truncate text-[10px] leading-3 text-muted-foreground">{entry.path}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingRestore({ path: entry.path, branch: entry.branch })}
                    className="mr-1 inline-flex h-8 shrink-0 items-center justify-center rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="max-h-56 overflow-y-auto">
            {repoWorktrees.map((rw) => (
              <React.Fragment key={rw.repo.repoPath}>
                {hasMultipleRepos && (
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    {rw.repo.name}
                  </div>
                )}
                {rw.worktrees.map((wt) => {
                  const selected = normalizePathKey(wt.path) === normalizePathKey(selectedPath ?? '')
                  return (
                    <div
                      key={wt.path}
                      className={cn('group flex items-center gap-1 rounded-lg', selected && 'bg-accent/45')}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(wt)
                          setIsOpen(false)
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent/60"
                      >
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium leading-4">{wt.branch}</span>
                          <span className="block truncate text-[10px] leading-3 text-muted-foreground">{wt.path}</span>
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{wt.head}</span>
                      </button>
                      {onOpenTerminal && (
                        <button
                          type="button"
                          onClick={() => onOpenTerminal(wt)}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[background-color,color,opacity,transform] hover:bg-background/80 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 active:scale-[0.96]"
                          title={`在 ${wt.branch} 打开终端`}
                          aria-label={`在 ${wt.branch} 打开终端`}
                        >
                          <SquareTerminal className="size-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setPendingRemoval({ worktree: wt, repoPath: rw.repo.repoPath })}
                        className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[background-color,color,opacity,transform] hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 active:scale-[0.96]"
                        title={`删除 ${wt.branch} Worktree`}
                        aria-label={`删除 ${wt.branch} Worktree`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <AlertDialog open={pendingRemoval !== null} onOpenChange={(open) => { if (!open && !isRemoving) setPendingRemoval(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Worktree？</AlertDialogTitle>
            <AlertDialogDescription>
              将执行 <code>git worktree remove --force</code> 删除
              {' '}<span className="font-medium text-foreground">{pendingRemoval?.worktree.branch}</span>
              {' '}（{pendingRemoval?.worktree.path}）。未提交的改动会一并丢失，且无法从 Proma 恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRemoving}
              onClick={(event) => { event.preventDefault(); void confirmRemoveWorktree() }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? '删除中…' : '删除 Worktree'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
