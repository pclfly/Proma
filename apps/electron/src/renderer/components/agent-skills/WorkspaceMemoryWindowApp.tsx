import * as React from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Code2, Eye, FilePlus2, FileText, Link2, Loader2, Lock, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import type { SkillFileNode, WorkspaceMemoryFileNode } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WindowControls } from '@/components/WindowControls'
import { MessageResponse } from '@/components/ai-elements/message'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import { getWindowTitlebarContentInsetClass } from '@/lib/window-titlebar-layout'
import { cn } from '@/lib/utils'

function flattenFiles(nodes: SkillFileNode[]): SkillFileNode[] {
  return nodes.flatMap((node) => node.type === 'directory' ? flattenFiles(node.children ?? []) : [node])
}

/** 与能力页一致的递归记忆树：保留链接徽标、受阻态与目录层级，不再把目录拍平。 */
function MemoryTreeRow({ node, level, selectedPath, expanded, onToggle, onOpen }: {
  node: WorkspaceMemoryFileNode
  level: number
  selectedPath: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}): React.ReactElement {
  const directory = node.type === 'directory'
  const blocked = node.linkState === 'unauthorized' || node.linkState === 'broken' || node.linkState === 'cycle'
  const open = expanded.has(node.relativePath)
  return (
    <div>
      <button
        type="button"
        disabled={blocked}
        title={blocked ? node.blockedReason ?? '未授权的外置链接' : node.linkState === 'authorized' ? '已授权的外置链接' : node.relativePath}
        onClick={() => directory ? onToggle(node.relativePath) : onOpen(node.relativePath)}
        className={cn('flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs transition-colors [-webkit-app-region:no-drag] disabled:opacity-60',
          selectedPath === node.relativePath ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60')}
        style={{ paddingLeft: 8 + level * 12 }}
      >
        {directory ? (open ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />) : <FileText size={13} className="shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.linkState === 'authorized' && <Link2 size={11} className="shrink-0 text-muted-foreground" />}
        {blocked && <Lock size={11} className="shrink-0 text-amber-600 dark:text-amber-400" />}
        {!directory && node.size != null && <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(node.size)}</span>}
      </button>
      {directory && open && (node.children ?? []).map((child) => (
        <MemoryTreeRow key={child.relativePath} node={child} level={level + 1} selectedPath={selectedPath} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
      ))}
    </div>
  )
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** Standalone, editable view of one workspace's managed memory/ root. */
export function WorkspaceMemoryWindowApp(): React.ReactElement {
  const params = new URLSearchParams(window.location.search)
  const workspaceSlug = params.get('workspace') ?? ''
  const initialFilePath = params.get('file')
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [files, setFiles] = React.useState<WorkspaceMemoryFileNode[]>([])
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [truncated, setTruncated] = React.useState(false)
  const [authorizedDirectories, setAuthorizedDirectories] = React.useState<string[]>([])
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const [remoteChanged, setRemoteChanged] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<'preview' | 'edit'>('preview')
  const [pendingAction, setPendingAction] = React.useState<{ kind: 'open'; relativePath: string } | { kind: 'close' } | null>(null)
  const selectedPathRef = React.useRef<string | null>(null)
  const dirtyRef = React.useRef(false)
  const textRef = React.useRef('')
  const baselineRef = React.useRef({ path: '', content: '', revision: undefined as string | undefined })
  /** 授权代际：撤销/重新授权后，撤销前发出的读取结果不能再回填。 */
  const accessEpochRef = React.useRef(0)

  React.useEffect(() => {
    selectedPathRef.current = selectedPath
    dirtyRef.current = dirty
    textRef.current = text
  }, [dirty, selectedPath, text])
  React.useEffect(() => {
    document.title = 'Proma · 工作区记忆'
  }, [])
  React.useEffect(() => {
    void window.electronAPI.markWorkspaceMemoryWindowReady(workspaceSlug).catch(() => {})
  }, [workspaceSlug])

  const refreshFiles = React.useCallback(async (): Promise<WorkspaceMemoryFileNode[]> => {
    const [tree, summary] = await Promise.all([
      window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
      window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
    ])
    const memoryTree = tree as WorkspaceMemoryFileNode[]
    setFiles(memoryTree)
    setTruncated(summary.autoMemory.truncated === true)
    setAuthorizedDirectories(summary.authorizedDirectories ?? [])
    return memoryTree
  }, [workspaceSlug])

  const openFile = React.useCallback(async (relativePath: string): Promise<void> => {
    const epoch = accessEpochRef.current
    setLoadingFile(true)
    try {
      const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
      if (epoch !== accessEpochRef.current) return // 授权已变化：丢弃撤销前取得的旧回复
      selectedPathRef.current = file.relativePath
      dirtyRef.current = false
      setSelectedPath(file.relativePath)
      baselineRef.current = { path: file.relativePath, content: file.content ?? '', revision: file.revision }
      textRef.current = file.content ?? ''
      setText(file.content ?? '')
      setDirty(false)
      setRemoteChanged(false)
      setViewMode('preview')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取记忆文件失败')
    } finally {
      setLoadingFile(false)
    }
  }, [workspaceSlug])

  const confirmClose = React.useCallback(async (): Promise<void> => {
    try {
      await window.electronAPI.confirmWorkspaceMemoryWindowClose(workspaceSlug)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关闭记忆窗口失败')
    }
  }, [workspaceSlug])

  const requestOpenFile = React.useCallback((relativePath: string): void => {
    if (relativePath === selectedPathRef.current) return
    if (saving) { toast.message('保存进行中，请稍候。'); return }
    if (dirtyRef.current) { setPendingAction({ kind: 'open', relativePath }); return }
    void openFile(relativePath)
  }, [openFile, saving])

  React.useEffect(() => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    let disposed = false
    void refreshFiles().then((tree) => {
      if (disposed) return
      const first = flattenFiles(tree).find((file) => file.relativePath === initialFilePath) ?? flattenFiles(tree).find((file) => file.relativePath === 'MEMORY.md') ?? flattenFiles(tree)[0]
      if (first) void openFile(first.relativePath)
    }).catch((error) => toast.error(error instanceof Error ? error.message : '读取记忆目录失败')).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true }
  }, [initialFilePath, openFile, refreshFiles, workspaceSlug])

  React.useEffect(() => window.electronAPI.onWorkspaceMemoryWindowOpenFile(requestOpenFile), [requestOpenFile])

  React.useEffect(() => window.electronAPI.onWorkspaceMemoryWindowCloseRequested(() => {
    if (saving) { toast.message('保存进行中，请稍候。'); return }
    if (dirtyRef.current) setPendingAction({ kind: 'close' })
    else void confirmClose()
  }), [confirmClose, saving])

  React.useEffect(() => {
    if (!workspaceSlug) return
    return window.electronAPI.subscribeWorkspaceMemoryChanges(workspaceSlug, (change) => {
      if (change.accessChanged) {
        // 授权变化：递增代际使迟到读取失效；干净状态清正文/基线，脏稿转隔离草稿并禁止隐式保存。
        accessEpochRef.current += 1
        setFiles([])
        setTruncated(false)
        baselineRef.current = { path: '', content: '', revision: undefined }
        if (dirtyRef.current) {
          setRemoteChanged(true)
        } else {
          textRef.current = ''
          setText('')
          setSelectedPath(null)
          setRemoteChanged(false)
        }
        void refreshFiles().catch(() => {})
        return
      }
      void refreshFiles().catch(() => {})
      if (change.relativePath !== selectedPathRef.current) return
      if (dirtyRef.current) {
        setRemoteChanged(true)
      } else if (change.kind !== 'deleted') {
        void openFile(change.relativePath)
      }
    })
  }, [openFile, refreshFiles, workspaceSlug])

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!selectedPath || remoteChanged || saving) return false
    const savedPath = selectedPath
    const savedText = textRef.current
    setSaving(true)
    try {
      const baseline = baselineRef.current
      if (baseline.path !== savedPath) throw new Error('记忆基线已变化，请重新载入')
      const written = await window.electronAPI.writeWorkspaceAutoMemoryFile(workspaceSlug, savedPath, savedText, baseline.content, baseline.revision)
      // 后继票据由main按实际提交目标签发，避免后台重读把编辑周期换绑到另一个文件。
      if (selectedPathRef.current === savedPath) {
        if (written.revision) baselineRef.current = { path: savedPath, content: savedText, revision: written.revision }
        else { baselineRef.current = { path: savedPath, content: savedText, revision: undefined }; setRemoteChanged(true) }
      }
      const unchangedSinceSave = selectedPathRef.current === savedPath && textRef.current === savedText
      dirtyRef.current = !unchangedSinceSave
      setDirty(!unchangedSinceSave)
      await refreshFiles()
      toast.success(unchangedSinceSave ? '记忆已保存' : '已保存早先内容；后续输入仍待保存')
      return unchangedSinceSave
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存记忆文件失败')
      return false
    } finally {
      setSaving(false)
    }
  }, [refreshFiles, remoteChanged, saving, selectedPath, workspaceSlug])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hasPrimaryModifier = event.metaKey || event.ctrlKey
      if (hasPrimaryModifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
      if (hasPrimaryModifier && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        window.electronAPI.windowClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const createIndex = React.useCallback(async (): Promise<void> => {
    // 新建同样建立“允许缺失文件”的读取基线：否则首次保存没有票据/基线，必然失败。
    const epoch = accessEpochRef.current
    try {
      const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, 'MEMORY.md')
      if (epoch !== accessEpochRef.current) return // 创建期间授权已变化：不建立旧基线
      selectedPathRef.current = file.relativePath
      setSelectedPath(file.relativePath)
      baselineRef.current = { path: file.relativePath, content: file.content ?? '', revision: file.revision }
      textRef.current = '# Memory\n'
      dirtyRef.current = true
      setText('# Memory\n')
      setDirty(true)
      setRemoteChanged(false)
      setViewMode('edit')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '新建记忆索引失败')
    }
  }, [workspaceSlug])

  const authorizeDirectory = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.authorizeWorkspaceKnowledgeDirectory(workspaceSlug)
      if (result.status === 'cancelled') return
      toast.success(`已授权外置目录：${result.path ?? ''}`)
      await refreshFiles()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '授权外置目录失败')
    }
  }, [refreshFiles, workspaceSlug])

  const revokeDirectory = React.useCallback(async (directory: string): Promise<void> => {
    try {
      await window.electronAPI.revokeWorkspaceKnowledgeDirectory(workspaceSlug, directory)
      toast.success('已撤销授权（未删除任何文件）')
      await refreshFiles()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤销授权失败')
    }
  }, [refreshFiles, workspaceSlug])

  const allFiles = React.useMemo(() => flattenFiles(files), [files])
  if (!workspaceSlug) {
    return <div className="flex h-screen items-center justify-center bg-content-area text-sm text-muted-foreground">未指定工作区，无法打开记忆编辑器。</div>
  }

  return (
    <TooltipProvider delayDuration={200}>
      <AlertDialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存记忆更改？</AlertDialogTitle>
            <AlertDialogDescription>当前文件有未保存的内容。你可以保存后继续，或丢弃本次更改。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
              const action = pendingAction
              setPendingAction(null)
              dirtyRef.current = false
              setDirty(false)
              if (action?.kind === 'open') void openFile(action.relativePath)
              else if (action?.kind === 'close') void confirmClose()
            }}>丢弃更改</AlertDialogAction>
            <AlertDialogAction onClick={() => {
              const action = pendingAction
              void (async () => {
                const saved = await save()
                if (!saved) return
                setPendingAction(null)
                if (action?.kind === 'open') await openFile(action.relativePath)
                else if (action?.kind === 'close') await confirmClose()
              })()
            }}>保存并继续</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className={cn('flex h-screen min-h-0 flex-col overflow-hidden bg-content-area antialiased', getWindowTitlebarContentInsetClass(isWindows))}>
        <WindowControls />
        <header className={cn(
          'relative flex h-12 shrink-0 items-center border-b border-border/70 titlebar-no-drag',
          isMac ? 'pl-[88px] pr-5' : 'px-5',
        )}>
          <div>
            <h1 className="text-sm font-semibold text-foreground">工作区记忆</h1>
            <p className="text-[11px] text-muted-foreground">{workspaceSlug} · memory/</p>
          </div>
        </header>
        <main className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-border/70 bg-muted/20">
            <div className="flex h-10 items-center justify-between border-b border-border/60 px-3">
              <span className="text-xs font-medium text-muted-foreground">记忆文件</span>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="授权外置目录" className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]" onClick={() => void authorizeDirectory()}><ShieldCheck size={14} /></button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">授权外置目录（同时成为工作区附加目录，工作区内 Agent 会话也可访问）</TooltipContent>
                </Tooltip>
                <button type="button" aria-label="刷新文件列表" className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]" onClick={() => void refreshFiles()}><RefreshCw size={14} /></button>
              </div>
            </div>
            {authorizedDirectories.length > 0 && (
              <div className="mx-2 mt-2 space-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1 font-medium"><Link2 size={11} />已授权外置目录</div>
                {authorizedDirectories.map((directory) => (
                  <div key={directory} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate" title={directory}>{directory}</span>
                    <button type="button" aria-label={`撤销授权 ${directory}`} className="rounded p-0.5 hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]" onClick={() => void revokeDirectory(directory)}><Lock size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="min-h-0 overflow-y-auto p-2">
              {loading ? <div className="p-3 text-xs text-muted-foreground">读取中…</div> : files.length === 0 ? (
                <div className="space-y-3 p-3 text-xs leading-relaxed text-muted-foreground"><p>尚未建立记忆文件。</p><Button size="sm" variant="outline" className="h-8 [-webkit-app-region:no-drag]" onClick={createIndex}><FilePlus2 size={14} className="mr-1.5" />新建 MEMORY.md</Button></div>
              ) : (
                <>
                  {truncated && <div role="status" className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">文件较多，当前只展示一部分。</div>}
                  {files.map((node) => (
                    <MemoryTreeRow key={node.relativePath} node={node} level={0} selectedPath={selectedPath} expanded={expanded}
                      onToggle={(path) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next })}
                      onOpen={requestOpenFile} />
                  ))}
                </>
              )}
            </div>
          </aside>
          <section className="flex min-h-0 flex-col bg-background">
            <div className="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-border/60 px-4">
              <div className="min-w-0"><div className="truncate text-sm font-medium text-foreground">{selectedPath ?? '选择记忆文件'}</div><div className="text-[11px] text-muted-foreground">Markdown · Cmd/Ctrl + S 保存</div></div>
              <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
                {selectedPath && <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                  <button type="button" onClick={() => setViewMode('preview')} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors', viewMode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}><Eye size={13} />预览</button>
                  <button type="button" onClick={() => setViewMode('edit')} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors', viewMode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}><Code2 size={13} />编辑</button>
                </div>}
                <Button size="sm" onClick={() => void save()} disabled={!selectedPath || !dirty || saving || remoteChanged}>{saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}{saving ? '保存中' : '保存'}</Button>
              </div>
            </div>
            {remoteChanged && <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200"><span>该文件已在其他位置更新。重新载入后再编辑，以免覆盖新内容。</span><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => selectedPath && void openFile(selectedPath)}>重新载入</Button></div>}
            {loadingFile ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">读取文件中…</div> : selectedPath && viewMode === 'edit' ? <textarea value={text} onChange={(event) => { dirtyRef.current = true; textRef.current = event.target.value; setText(event.target.value); setDirty(true) }} disabled={saving} spellCheck={false} className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-[13px] leading-6 text-foreground outline-none" placeholder="# Memory\n\n记录稳定、可复用的协作知识。" /> : selectedPath ? <div className="min-h-0 flex-1 overflow-y-auto p-6">{text.trim() ? <MessageResponse className="prose-headings:scroll-mt-4">{text}</MessageResponse> : <div className="flex h-full min-h-[240px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">当前文件为空，切换到编辑后可以写入 Markdown 内容。</div>}</div> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">从左侧选择一个记忆文件</div>}
          </section>
        </main>
      </div>
    </TooltipProvider>
  )
}
