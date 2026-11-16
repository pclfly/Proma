import * as React from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, Trash2 } from 'lucide-react'
import type { VaultFileEntry } from '@proma/shared'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VirtualSidebarList } from '@/components/ui/virtual-sidebar-list'
import { cn } from '@/lib/utils'
import { buildVaultTreeFromDirectories, flattenVaultTree, getVaultFileRowKey, getVaultFolderRowKey } from './vault-tree-model'
import type { VaultDirectoryController } from './vault-directory-controller'

const displayDocumentTitle = (filename: string): string => filename.replace(/\.md$/i, '')

export function VaultFileList({
  controller,
  selectedPath,
  focusedFolder,
  onSelect,
  onFocusFolder,
  onDelete,
  onCreateNote,
  onCreateFolder,
  canCreate,
  treeAction,
}: {
  controller: VaultDirectoryController
  selectedPath: string | null
  focusedFolder: string | null
  onSelect: (relativePath: string) => void
  onFocusFolder: (relativePath: string) => void
  onDelete: (file: VaultFileEntry) => void
  onCreateNote: (folderPath: string) => void
  onCreateFolder: (folderPath: string) => void
  canCreate: boolean
  treeAction: { type: 'expand' | 'collapse'; version: number }
}): React.ReactElement {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const tree = React.useMemo(
    () => buildVaultTreeFromDirectories(snapshot.directories.get('') ?? [], snapshot.directories),
    [snapshot.directories],
  )
  const rows = React.useMemo(() => flattenVaultTree(tree, snapshot.expanded), [tree, snapshot.expanded])

  React.useEffect(() => {
    if (treeAction.version === 0) return
    if (treeAction.type === 'expand') void controller.expandAll()
    else controller.collapseAll()
  }, [controller, treeAction])

  React.useEffect(() => {
    if (selectedPath) void controller.reveal(selectedPath)
  }, [controller, selectedPath])

  React.useEffect(() => {
    // 聚焦目录只展开祖先，不能在用户收起后再把同一目录自动展开。
    if (focusedFolder) void controller.reveal(focusedFolder)
  }, [controller, focusedFolder])

  const rootError = snapshot.errors.get('')
  const toggleFolder = (relativePath: string): void => {
    onFocusFolder(relativePath)
    void controller.toggle(relativePath)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {snapshot.expandingAll && (
        <div role="status" className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />正在逐层展开
          <button type="button" onClick={() => controller.collapseAll()} className="ml-auto underline">取消</button>
        </div>
      )}
      {rootError && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {rootError}<button type="button" onClick={() => { void controller.refresh() }} className="ml-2 underline">重试</button>
        </div>
      )}
      {rows.length === 0 && !rootError && (
        <p role="status" className="px-4 py-6 text-center text-xs text-muted-foreground">
          {snapshot.loading.has('') ? '正在读取目录…' : '没有可显示的 Markdown 笔记或文件夹'}
        </p>
      )}
    <VirtualSidebarList
      className="min-h-0 flex-1 px-2 pb-3"
      activeRowId={focusedFolder ? getVaultFolderRowKey(focusedFolder) : selectedPath ? getVaultFileRowKey(selectedPath) : null}
      rows={rows.map((row) => {
        if (row.kind === 'folder') {
          const focused = focusedFolder === row.relativePath
          return {
            id: row.key,
            estimateSize: 32,
            content: (
              <>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    aria-expanded={row.expanded}
                    aria-label={`${row.expanded ? '收起' : '展开'}文件夹 ${row.name}`}
                    onClick={() => toggleFolder(row.relativePath)}
                    className={cn(
                      'flex h-9 w-full min-w-0 items-center gap-1 rounded-md pr-2 text-left text-sm transition-colors hover:bg-muted/70 hover:text-foreground',
                      focused ? 'bg-accent text-accent-foreground shadow-sm' : 'text-foreground/80',
                    )}
                    style={{ paddingLeft: `${10 + Math.min(row.depth, 6) * 14}px` }}
                  >
                    {snapshot.loading.has(row.relativePath)
                      ? <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
                      : row.expanded ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                    {row.expanded ? <FolderOpen size={14} className="shrink-0 text-primary/80" /> : <Folder size={14} className="shrink-0 text-primary/80" />}
                    <span className="min-w-0 truncate">{row.name}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="z-[9999] w-40 min-w-0 p-0.5">
                  <ContextMenuItem disabled={!canCreate} onSelect={() => onCreateNote(row.relativePath)}>新建笔记</ContextMenuItem>
                  <ContextMenuItem disabled={!canCreate} onSelect={() => onCreateFolder(row.relativePath)}>新建文件夹</ContextMenuItem>
                  <ContextMenuItem onSelect={() => { void window.electronAPI.openVaultFolder(row.relativePath) }}>在文件管理器中打开</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {snapshot.errors.has(row.relativePath) && (
                <button type="button" onClick={() => { void controller.retry(row.relativePath) }} className="w-full px-4 py-1 text-left text-xs text-destructive" aria-label={`重试目录 ${row.name}`}>
                  {snapshot.errors.get(row.relativePath)} · 重试
                </button>
              )}
              </>
            ),
          }
        }

        const file = row.file
        const selected = selectedPath === file.relativePath
        return {
          id: row.key,
          estimateSize: 32,
          content: (
            <ContextMenu>
              <ContextMenuTrigger asChild>
            <div
              className={cn(
                'group flex h-8 w-full min-w-0 items-center rounded-md transition-colors',
                selected ? 'bg-accent text-accent-foreground shadow-sm' : 'text-foreground/70 hover:bg-muted/70 hover:text-foreground',
              )}
              style={{ paddingLeft: `${18 + Math.min(row.depth, 6) * 14}px` }}
            >
              <button
                type="button"
                title={file.relativePath}
                onClick={() => onSelect(file.relativePath)}
                className="h-full min-w-0 flex-1 truncate text-left text-sm"
              >
                {displayDocumentTitle(file.name)}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`删除笔记 ${displayDocumentTitle(file.name)}`}
                    onClick={() => onDelete(file)}
                    className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color,background-color] hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">删除笔记</TooltipContent>
              </Tooltip>
            </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="z-[9999] w-44 min-w-0 p-0.5">
                <ContextMenuItem onSelect={() => { void window.electronAPI.showVaultFileInFolder(file.relativePath) }}>
                  在文件管理器中显示
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ),
        }
      })}
    />
    </div>
  )
}

