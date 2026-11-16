import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { AlertTriangle, Brain, ChevronDown, ChevronRight, FileText, FolderOpen, Link2, Lock, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import type { SkillFileNode, WorkspaceMemoryFileNode, WorkspaceMemorySummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard } from '@/components/settings/primitives'
import { AgentActionHint } from '@/components/agent/AgentActionHint'
import { WorkspaceMemoryChangeShelf } from './WorkspaceMemoryChangeShelf'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { memoryFileNavigationAtom, workspaceKnowledgeAccessAtom, workspaceMemoryChangesAtom } from '@/atoms/memory-change-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'
import { cn } from '@/lib/utils'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import {
  buildWorkspaceKnowledgeBootstrapPrompt,
  buildWorkspaceSessionEvidencePrompt,
  MEMORY_HISTORY_RANGE_OPTIONS,
  type MemoryHistoryRange,
} from './workspaceMemoryInitPrompt'

type SelectedMemoryFile =
  | { kind: 'agents'; relativePath: 'AGENTS.md'; title: string; absolutePath: string; revision?: string }
  | { kind: 'auto'; relativePath: string; title: string; absolutePath: string; revision?: string }

type MemorySaveDisposition = 'saved' | 'blocked'

interface WorkspaceMemoryTabProps {
  workspaceSlug: string
  /** 仅嵌入 Agent 右侧工作区时传入，用于展示当前会话的记忆变更 Diff。 */
  sessionId?: string
  /** 记忆 Diff 查看结束或失效时关闭当前会话的项目记忆 Tab，避免回退到完整记忆。 */
  onCloseChangeView?: () => void
  /** 能力中心传入的统一搜索词；嵌入组件未传时提供自己的内容搜索。 */
  search?: string
  embedded?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function autoMemoryPath(summary: WorkspaceMemorySummary, relativePath: string): string {
  const directory = summary.autoMemory.directory
  // directory 由主进程 join() 生成，Windows 上使用反斜杠；沿用其分隔符风格，
  // 并把 relativePath 里的正斜杠归一化，避免拼出 C:\...\memory/MEMORY.md 这类混合路径。
  const sep = directory.includes('\\') && !directory.includes('/') ? '\\' : '/'
  const normalizedRelative = relativePath.replace(/[\\/]/g, sep)
  const trimmedDir = directory.replace(/[\\/]+$/, '')
  return `${trimmedDir}${sep}${normalizedRelative}`
}


function filterNodes(nodes: SkillFileNode[], query: string, contentMatchPaths = new Set<string>()): SkillFileNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const result: SkillFileNode[] = []
  for (const node of nodes) {
    const children = node.children ? filterNodes(node.children, query, contentMatchPaths) : undefined
    const selfMatch =
      node.name.toLowerCase().includes(q) ||
      node.relativePath.toLowerCase().includes(q) ||
      contentMatchPaths.has(node.relativePath)
    if (selfMatch || (children && children.length > 0)) {
      result.push({ ...node, children })
    }
  }
  return result
}

export function WorkspaceMemoryTab({ workspaceSlug, sessionId, search, embedded = false, onCloseChangeView }: WorkspaceMemoryTabProps): React.ReactElement {
  const { createAgent } = useCreateSession()
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  /** 授权变化必须先清缓存再重读；用ref接收刷新函数避免在声明前引用。 */
  const refreshForAccessRef = React.useRef<(() => Promise<unknown>) | null>(null)
  const openMemoryRef = React.useRef<{ agents: (summary: WorkspaceMemorySummary) => Promise<void>; auto: (path: string, summary?: WorkspaceMemorySummary) => Promise<void> } | null>(null)
  /** 授权代际：所有读取/续票回填都要与发起时的代际一致，撤销后迟到回复必须丢弃。 */
  const accessEpochRef = React.useRef(0)
  const [memoryNavigationRequest, setMemoryNavigationRequest] = useAtom(memoryFileNavigationAtom)
  const workspaceMemoryChanges = useAtomValue(workspaceMemoryChangesAtom)
  const memoryChanges = workspaceMemoryChanges.get(workspaceSlug) ?? []
  const latestMemoryChange = memoryChanges[0]
  const workspaceAccessRevisions = useAtomValue(workspaceKnowledgeAccessAtom)
  const accessRevision = workspaceAccessRevisions.get(workspaceSlug) ?? 0
  const [activeChangeId, setActiveChangeId] = React.useState<string | null>(null)
  const activeMemoryChange = activeChangeId
    ? memoryChanges.find((change) => `${change.relativePath}:${change.changedAt}` === activeChangeId)
    : undefined
  const [summary, setSummary] = React.useState<WorkspaceMemorySummary | null>(null)
  const [autoFiles, setAutoFiles] = React.useState<WorkspaceMemoryFileNode[]>([])
  const [selected, setSelected] = React.useState<SelectedMemoryFile | null>(null)
  const [editText, setEditText] = React.useState('')
  const [editBaseText, setEditBaseText] = React.useState('')
  const [saveConflict, setSaveConflict] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [isDirty, setIsDirty] = React.useState(false)
  const [bootstrapping, setBootstrapping] = React.useState(false)
  const [scanningHistory, setScanningHistory] = React.useState(false)
  const [historyRange, setHistoryRange] = React.useState<MemoryHistoryRange>('1m')
  const [contentMatches, setContentMatches] = React.useState<Map<string, string>>(new Map())
  // 右侧项目记忆 Tab 不提供搜索；全屏能力中心仍复用其顶部搜索框。
  const effectiveSearch = embedded ? '' : (search ?? '')

  // 自动保存：用 ref 持有最新的编辑状态，供防抖定时器与"切换文件前 flush"复用，
  // 避免把 selected/editText 塞进一堆回调的依赖数组里。
  const saveStateRef = React.useRef<{ selected: SelectedMemoryFile | null; editText: string; editBaseText: string; isDirty: boolean; saveConflict: boolean }>({
    selected: null,
    editText: '',
    editBaseText: '',
    isDirty: false,
    saveConflict: false,
  })
  React.useEffect(() => {
    saveStateRef.current = { selected, editText, editBaseText, isDirty, saveConflict }
  }, [selected, editText, editBaseText, isDirty, saveConflict])
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = React.useRef<Promise<MemorySaveDisposition> | null>(null)
  const historyRangeLabel = React.useMemo(
    () => MEMORY_HISTORY_RANGE_OPTIONS.find((option) => option.value === historyRange)?.label ?? '近 1 个月',
    [historyRange],
  )

  const refreshSummaryAndTree = React.useCallback(async (): Promise<WorkspaceMemorySummary> => {
    const epoch = accessEpochRef.current
    const [nextSummary, files] = await Promise.all([
      window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
      window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
    ])
    if (epoch !== accessEpochRef.current) throw new Error('授权已变化，请刷新后重试')
    setSummary(nextSummary)
    setAutoFiles(files)
    return nextSummary
  }, [workspaceSlug])

  refreshForAccessRef.current = refreshSummaryAndTree

  /** 授权变化只刷新授权/树/摘要；干净时才重读正文，脏稿保留并停止隐式保存。 */
  const refreshAccessOnly = React.useCallback(async (): Promise<void> => {
    accessEpochRef.current += 1
    setAutoFiles([])
    setContentMatches(new Map())
    if (saveStateRef.current.isDirty) {
      setSaveConflict(true)
      await refreshSummaryAndTree().catch(() => {})
      return
    }
    setEditText('')
    setEditBaseText('')
    setSelected((prev) => (prev ? { ...prev, revision: undefined } : prev))
    const nextSummary = await refreshSummaryAndTree().catch(() => null)
    const current = saveStateRef.current.selected
    if (!current || !nextSummary || saveStateRef.current.isDirty) return
    if (current.kind === 'agents') await openMemoryRef.current?.agents(nextSummary)
    else await openMemoryRef.current?.auto(current.relativePath, nextSummary)
  }, [refreshSummaryAndTree])

  React.useEffect(() => {
    if (accessRevision === 0) return
    void refreshAccessOnly()
    // 仅在授权代际变化时执行；函数引用变化不应重放。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessRevision])

  /** 保存结果直接决定是否允许导航，不依赖React被动effect何时同步ref。 */
  const persistTarget = React.useCallback(async (target: SelectedMemoryFile, text: string, baseText: string): Promise<MemorySaveDisposition> => {
    const epoch = accessEpochRef.current
    const written = target.kind === 'agents'
      ? await window.electronAPI.writeWorkspaceAgentsMd(workspaceSlug, text, baseText, target.revision)
      : await window.electronAPI.writeWorkspaceAutoMemoryFile(workspaceSlug, target.relativePath, text, baseText, target.revision)
    const current = saveStateRef.current
    const stillSelected = current.selected?.kind === target.kind && current.selected.relativePath === target.relativePath
    if (epoch !== accessEpochRef.current || !stillSelected) return 'blocked'
    if (!written.revision || written.requiresReopen) {
      const nextSelected = { ...target, revision: undefined }
      // 同步建立阻断状态，防止同一微任务中的后续导航读到旧ref。
      saveStateRef.current = { ...current, selected: nextSelected, saveConflict: true, isDirty: true }
      setSelected(nextSelected)
      setSaveConflict(true)
      setIsDirty(true)
      return 'blocked'
    }
    const nextSelected = { ...target, revision: written.revision }
    const hasNewInput = current.editText !== text
    saveStateRef.current = { ...current, selected: nextSelected, editBaseText: text, isDirty: hasNewInput, saveConflict: false }
    setSelected(nextSelected)
    setEditBaseText(text)
    setIsDirty(hasNewInput)
    setSaveConflict(false)
    if (!hasNewInput) setEditText(text)
    // 摘要刷新不改变已经提交的保存结果；失败不触发文件重写或覆盖草稿。
    void refreshSummaryAndTree().catch((error) => { console.warn('[工作区记忆] 保存后刷新摘要失败:', error) })
    return hasNewInput ? 'blocked' : 'saved'
  }, [workspaceSlug, refreshSummaryAndTree])

  /**
   * 把待保存的脏内容立即刷盘（静默，失败才提示）。
   * 切换文件、刷新、卸载和 Cmd/Ctrl+S 都复用本入口，确保写入顺序一致。
   */
  /** 返回是否可安全继续后续导航：失败或存在冲突时必须由调用方终止，不能只靠 setState。 */
  const flushPendingSave = React.useCallback(async (): Promise<boolean> => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    if (persistInFlightRef.current) {
      try { if (await persistInFlightRef.current === 'blocked') return false } catch { return false }
    }
    const { selected: curSelected, editText: curText, editBaseText: curBaseText, isDirty: curDirty, saveConflict: curSaveConflict } = saveStateRef.current
    if (curSaveConflict) return false
    if (!curSelected || !curDirty) return true
    try {
      const p = persistTarget(curSelected, curText, curBaseText)
      persistInFlightRef.current = p
      const disposition = await p
      // 先尊重明确的blocked结果；setState尚未提交也不能被旧ref放行。
      if (disposition !== 'saved') return false
      const after = saveStateRef.current
      return !after.isDirty && !after.saveConflict
    } catch (err) {
      console.error('[工作区记忆] 自动保存失败:', err)
      const message = err instanceof Error ? err.message : '自动保存失败'
      toast.error(message)
      // 外部更新、票据过期、授权撤销都必须停止自动保存并保留草稿，不能继续覆盖。
      saveStateRef.current = { ...saveStateRef.current, saveConflict: true, isDirty: true }
      setSaveConflict(true)
      setIsDirty(true)
      return false
    } finally {
      persistInFlightRef.current = null
    }
  }, [persistTarget])

  const openAgents = React.useCallback(async (knownSummary?: WorkspaceMemorySummary): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      toast.error('当前文件有外部更新，请先刷新或复制修改后再切换。')
      return
    }
    if (!await flushPendingSave()) return
    setLoadingFile(true)
    const epoch = accessEpochRef.current
    try {
      const currentSummary = knownSummary ?? summary ?? await window.electronAPI.getWorkspaceMemorySummary(workspaceSlug)
      const file = await window.electronAPI.readWorkspaceAgentsMd(workspaceSlug)
      // 授权可能在读取期间变化：丢弃撤销前取得的正文与票据。
      if (epoch !== accessEpochRef.current) return
      setSelected({
        kind: 'agents',
        relativePath: 'AGENTS.md',
        title: 'AGENTS.md',
        absolutePath: currentSummary.agentsMd.path,
        revision: file.revision,
      })
      setEditText(file.content ?? '')
      setEditBaseText(file.content ?? '')
      setSaveConflict(false)
      setIsDirty(false)
    } catch (err) {
      console.error('[工作区记忆] 读取 AGENTS.md 失败:', err)
      toast.error(err instanceof Error ? err.message : '读取 AGENTS.md 失败')
    } finally {
      setLoadingFile(false)
    }
  }, [summary, workspaceSlug, flushPendingSave])

  const openAutoFile = React.useCallback(async (relativePath: string, knownSummary?: WorkspaceMemorySummary): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      toast.error('当前文件有外部更新，请先刷新或复制修改后再切换。')
      return
    }
    if (!await flushPendingSave()) return
    setLoadingFile(true)
    const epoch = accessEpochRef.current
    try {
      const currentSummary = knownSummary ?? summary ?? await window.electronAPI.getWorkspaceMemorySummary(workspaceSlug)
      const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
      // 同一授权代际内才允许回填；revoked后旧回复不能复活正文/票据。
      if (epoch !== accessEpochRef.current) return
      setSelected({
        kind: 'auto',
        relativePath: file.relativePath,
        title: file.relativePath,
        absolutePath: autoMemoryPath(currentSummary, file.relativePath),
        revision: file.revision,
      })
      setEditText(file.content ?? '')
      setEditBaseText(file.content ?? '')
      setSaveConflict(false)
      setIsDirty(false)
    } catch (err) {
      console.error('[工作区记忆] 读取长期记忆文件失败:', err)
      toast.error(err instanceof Error ? err.message : '读取长期记忆文件失败')
    } finally {
      setLoadingFile(false)
    }
  }, [summary, workspaceSlug, flushPendingSave])

  React.useEffect(() => {
    if (!memoryNavigationRequest || memoryNavigationRequest.workspaceSlug !== workspaceSlug) return
    if (memoryNavigationRequest.mode === 'change') {
      const change = memoryChanges.find((item) => item.relativePath === memoryNavigationRequest.relativePath)
      if (change && sessionId) setActiveChangeId(`${change.relativePath}:${change.changedAt}`)
      setMemoryNavigationRequest(null)
      return
    }
    void (async () => {
      await openAutoFile(memoryNavigationRequest.relativePath)
      setMemoryNavigationRequest(null)
    })()
  }, [memoryChanges, memoryNavigationRequest, openAutoFile, sessionId, setMemoryNavigationRequest, workspaceSlug])

  // 授权变化后需要按当前权限重开当前文件；用 ref 传入避免刷新函数依赖声明顺序。
  openMemoryRef.current = { agents: openAgents, auto: openAutoFile }

  React.useEffect(() => {
    if (!embedded || !activeChangeId || activeMemoryChange) return
    // Diff 对应的临时变更已经被消费或被新变更替换时，不能落回完整记忆列表。
    // 完整记忆只由用户主动打开项目记忆 Tab 查看。
    onCloseChangeView?.()
  }, [activeChangeId, activeMemoryChange, embedded, onCloseChangeView])

  React.useEffect(() => {
    if (!latestMemoryChange) return
    void refreshSummaryAndTree().catch((error) => console.error('[工作区记忆] 刷新全局变更失败:', error))
  }, [latestMemoryChange?.changedAt, refreshSummaryAndTree])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      saveStateRef.current = { ...saveStateRef.current, saveConflict: false, isDirty: false }
      setSaveConflict(false)
      setIsDirty(false)
    } else if (!await flushPendingSave()) {
      return
    }
    setLoading(true)
    try {
      const nextSummary = await refreshSummaryAndTree()
      if (selected?.kind === 'auto') {
        await openAutoFile(selected.relativePath, nextSummary)
      } else {
        await openAgents(nextSummary)
      }
    } catch (err) {
      console.error('[工作区记忆] 刷新失败:', err)
      toast.error('刷新协作知识失败')
    } finally {
      setLoading(false)
    }
  }, [openAutoFile, openAgents, refreshSummaryAndTree, selected, flushPendingSave])

  /** 授权动作只发起意图；真正的文件夹选择与持久化在 main 完成。 */
  const authorizeDirectory = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.authorizeWorkspaceKnowledgeDirectory(workspaceSlug)
      if (result.status === 'cancelled') return
      toast.success(`已授权外置目录：${result.path ?? ''}`)
      await refreshAccessOnly()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '授权外置目录失败')
    }
  }, [refreshAccessOnly, workspaceSlug])

  const revokeDirectory = React.useCallback(async (directory: string): Promise<void> => {
    try {
      await window.electronAPI.revokeWorkspaceKnowledgeDirectory(workspaceSlug, directory)
      toast.success('已撤销授权（未删除任何文件）')
      await refreshAccessOnly()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤销授权失败')
    }
  }, [refreshAccessOnly, workspaceSlug])

  React.useEffect(() => {
    let cancelled = false
    setSelected(null)
    setEditText('')
    setEditBaseText('')
    setSaveConflict(false)
    setIsDirty(false)
    setExpanded(new Set())
    setLoading(true)
    const epoch = accessEpochRef.current
    void (async () => {
      try {
        const [nextSummary, files, claudeFile] = await Promise.all([
          window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
          window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
          window.electronAPI.readWorkspaceAgentsMd(workspaceSlug),
        ])
        // 授权代际变化（撤销/重新授权）后，bootstrap 的迟到回复不得恢复旧正文与旧票据。
        if (cancelled || epoch !== accessEpochRef.current) return
        setSummary(nextSummary)
        setAutoFiles(files)
        setSelected({
          kind: 'agents',
          relativePath: 'AGENTS.md',
          title: 'AGENTS.md',
          absolutePath: nextSummary.agentsMd.path,
          // 首次打开也要带上读票据，否则第一次保存只能走无票据分支。
          revision: claudeFile.revision,
        })
        setEditText(claudeFile.content ?? '')
        setEditBaseText(claudeFile.content ?? '')
        setSaveConflict(false)
        setIsDirty(false)
      } catch (err) {
        console.error('[工作区记忆] 加载失败:', err)
        toast.error('加载协作知识失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceSlug])

  // 防抖自动保存：编辑内容变脏后 800ms 内无新输入则自动保存。
  React.useEffect(() => {
    if (!selected || !isDirty || loadingFile) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      void flushPendingSave()
    }, 800)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [editText, selected, isDirty, loadingFile, flushPendingSave])

  // 组件卸载（如切走 Tab）时，把未保存内容刷盘，防止编辑丢失
  React.useEffect(() => {
    return () => {
      void flushPendingSave()
    }
  }, [flushPendingSave])


  const startGuidedSession = async (message: string, kind: 'bootstrap' | 'history'): Promise<void> => {
    const setLoadingState = kind === 'bootstrap' ? setBootstrapping : setScanningHistory
    setLoadingState(true)
    try {
      const sessionId = await createAgent()
      if (!sessionId) {
        toast.error('创建 Agent 会话失败')
        return
      }
      setPendingPrompt({ sessionId, message })
      toast.success(kind === 'bootstrap' ? '已创建项目地图与协作画像引导会话' : '已创建会话补证据任务')
    } catch (err) {
      console.error('[工作区记忆] 创建引导会话失败:', err)
      toast.error(err instanceof Error ? err.message : '创建引导会话失败')
    } finally {
      setLoadingState(false)
    }
  }

  const handleBootstrapKnowledge = async (): Promise<void> => {
    if (bootstrapping) return
    try {
      await window.electronAPI.approveWorkspaceProjectKnowledgeMaintenance(workspaceSlug)
      await startGuidedSession(buildWorkspaceKnowledgeBootstrapPrompt(), 'bootstrap')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '记录项目知识维护授权失败')
    }
  }

  const handleScanSessionEvidence = async (): Promise<void> => {
    if (scanningHistory || !hasProfile) return
    await startGuidedSession(buildWorkspaceSessionEvidencePrompt(historyRange), 'history')
  }

  // 文件名之外也可按正文内容检索。只在用户主动搜索时读取文本文件，做 180ms 防抖、
  // 忽略大文件并限制候选数，避免右侧面板的每次输入触发大量 IPC 或重渲染。
  React.useEffect(() => {
    const query = effectiveSearch.trim().toLowerCase()
    if (!query) {
      setContentMatches(new Map())
      return
    }
    const candidates: SkillFileNode[] = []
    const collect = (nodes: SkillFileNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directory') collect(node.children ?? [])
        else if (node.isText !== false && (node.size ?? 0) <= 512 * 1024) candidates.push(node)
      }
    }
    collect(autoFiles)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void Promise.all(candidates.slice(0, 60).map(async (node) => {
        try {
          const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, node.relativePath)
          const line = (file.content ?? '').split(/\r?\n/).find((item) => item.toLowerCase().includes(query))
          return line ? [node.relativePath, line.trim().slice(0, 160)] as const : null
        } catch {
          return null
        }
      })).then((results) => {
        if (cancelled) return
        setContentMatches(new Map(results.filter((result): result is readonly [string, string] => result !== null)))
      })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoFiles, effectiveSearch, workspaceSlug])

  const visibleAutoFiles = React.useMemo(
    () => filterNodes(autoFiles, effectiveSearch, new Set(contentMatches.keys())),
    [autoFiles, contentMatches, effectiveSearch],
  )
  const hasProfile = autoFiles.some((node) => node.relativePath === 'user-profile.md')
  const migrationIssues = [
    summary?.legacyAutoMemory ? '长期记忆迁移' : null,
    summary?.instructionConflict ? '工作区规则迁移' : null,
  ].filter((issue): issue is string => issue !== null)
  const migrationReminderTitle = [
    summary?.legacyAutoMemory ? `长期记忆：${summary.legacyAutoMemory.directory}` : null,
    summary?.instructionConflict ? `工作区规则：${summary.instructionConflict.legacyPath}` : null,
  ].filter((detail): detail is string => detail !== null).join('\n')

  if (activeMemoryChange && sessionId) {
    return (
      <WorkspaceMemoryChangeShelf
        changes={memoryChanges}
        onOpenFile={(change) => {
          setActiveChangeId(null)
          void openAutoFile(change.relativePath)
        }}
        onDismissChanges={embedded ? onCloseChangeView : undefined}
        className="h-full min-h-0 overflow-auto bg-content-area p-3"
      />
    )
  }

  if (loading || !summary) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载协作知识中...</div>
  }

  return (
    <div className={cn('flex flex-col gap-5', embedded && 'h-full min-h-0 gap-3')}>
      {embedded && (
        <div className="flex shrink-0 items-center gap-2 rounded-xl bg-muted/45 px-3 py-2">
          <Brain className="size-4 shrink-0 text-foreground/65" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">项目记忆</div>
            <div className="text-[11px] text-muted-foreground">{summary.autoMemory.fileCount} 个记忆文件</div>
          </div>
        </div>
      )}
      {embedded && <AgentActionHint action="查找、补充或整理项目记忆" />}
      {!embedded && <SettingsCard divided={false}>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">建立项目地图与协作画像</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              点击即授权 Agent 基于可验证证据维护项目根与 Proma 工作区的 AGENTS.md；随后在真实协作中逐步校准你的偏好。不会扫描历史会话。
            </div>
          </div>
          <Button onClick={handleBootstrapKnowledge} disabled={bootstrapping}>
            <Sparkles size={14} className="mr-1.5" />
            {bootstrapping ? '创建中...' : '同意并开始建立'}
          </Button>
        </div>
      </SettingsCard>}

      {!embedded && <SettingsCard divided={false}>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">授权会话补证据</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hasProfile
                ? `仅在你授权的范围内，分批选择少量高信号工作会话补充证据；不会全量扫描，协作记忆仍须确认后写入。`
                : '先在真实协作中建立初步协作画像，再决定是否用历史会话补充证据。'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={historyRange} onValueChange={(value) => setHistoryRange(value as MemoryHistoryRange)} disabled={scanningHistory || !hasProfile}>
              <SelectTrigger className="h-9 w-[116px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MEMORY_HISTORY_RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleScanSessionEvidence} disabled={scanningHistory || !hasProfile} title={hasProfile ? undefined : '请先建立协作画像'}>
              <Sparkles size={14} className="mr-1.5" />
              {scanningHistory ? '创建中...' : '授权整理'}
            </Button>
          </div>
        </div>
      </SettingsCard>}

      <div className={cn('grid min-h-[520px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]', embedded && 'min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)] gap-3')}>
        <SettingsCard divided={false} className="min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="text-[13px] font-medium text-foreground/75">记忆文件</div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="授权外置目录"
                      onClick={() => void authorizeDirectory()}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <ShieldCheck size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">授权外置目录（该目录同时成为工作区附加目录，工作区内 Agent 会话也可访问）</TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  title="刷新"
                  onClick={() => void refresh()}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>
            {migrationIssues.length > 0 && (
              <div
                role="status"
                title={migrationReminderTitle}
                className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle size={13} className="shrink-0" />
                <span>待处理：{migrationIssues.join('、')}，请检查旧文件。</span>
              </div>
            )}
            {(summary.authorizedDirectories ?? []).length > 0 && (
              <div className="mx-2 mt-2 space-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1 font-medium"><Link2 size={11} />已授权外置目录</div>
                {(summary.authorizedDirectories ?? []).map((directory) => (
                  <div key={directory} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate" title={directory}>{directory}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label={`撤销授权 ${directory}`} onClick={() => void revokeDirectory(directory)} className="rounded p-0.5 hover:bg-accent hover:text-foreground">
                          <Trash2 size={11} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">撤销授权（不删除任何文件）</TooltipContent>
                    </Tooltip>
                  </div>
                ))}
              </div>
            )}
            {summary.autoMemory.truncated && (
              <div role="status" className="mx-2 mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">记忆文件较多，当前只展示一部分；计数与搜索同样不完整。</div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <FileButton
                active={selected?.kind === 'agents'}
                icon={<FileText size={14} />}
                label="AGENTS.md"
                meta="Proma 工作区项目指令"
                onClick={() => void openAgents(summary)}
                onReveal={() => window.electronAPI.showItemInFolder(summary.agentsMd.path)}
              />
              <div className="mt-3 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                长期记忆
              </div>
              <div className="space-y-0.5">
                {visibleAutoFiles.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的记忆文件</div>
                ) : (
                  visibleAutoFiles.map((node) => (
                    <MemoryTreeNode
                      key={node.relativePath}
                      node={node}
                      level={0}
                      selectedPath={selected?.kind === 'auto' ? selected.relativePath : null}
                      expanded={expanded}
                      contentMatches={contentMatches}
                      onToggle={(path) => {
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(path)) next.delete(path)
                          else next.add(path)
                          return next
                        })
                      }}
                      onOpen={(path) => void openAutoFile(path, summary)}
                      onReveal={(path) => window.electronAPI.showItemInFolder(autoMemoryPath(summary, path))}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard divided={false} className="min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {selected?.title ?? '未选择文件'}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {selected?.absolutePath ?? '从左侧选择一个记忆文件'}
                </div>
              </div>

            </div>
            {saveConflict && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span>文件已被外部更新，已停止保存以避免覆盖。请复制你的修改后刷新文件。</span>
                <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => void refresh()}>刷新文件</Button>
              </div>
            )}
            {loadingFile ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">读取文件中...</div>
            ) : selected ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <LiveMarkdownEditor
                  value={editText}
                  onChange={(value) => {
                    saveStateRef.current = { ...saveStateRef.current, isDirty: true, editText: value }
                    setIsDirty(true)
                    setEditText(value)
                  }}
                  onSave={() => { void flushPendingSave() }}
                  readOnly={saveConflict}
                  className="live-markdown-external-scroll"
                />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">从左侧选择一个记忆文件</div>
            )}
          </div>
        </SettingsCard>
      </div>
    </div>
  )
}

function FileButton({
  active,
  icon,
  label,
  meta,
  onClick,
  onReveal,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  meta?: string
  onClick: () => void
  onReveal: () => void
}): React.ReactElement {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta && <span className="truncate text-[11px] text-muted-foreground">{meta}</span>}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReveal}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`打开 ${label} 所在位置`}
          >
            <FolderOpen size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">打开文件所在位置</TooltipContent>
      </Tooltip>
    </div>
  )
}

function MemoryTreeNode({
  node,
  level,
  selectedPath,
  expanded,
  contentMatches,
  onToggle,
  onOpen,
  onReveal,
}: {
  node: WorkspaceMemoryFileNode
  level: number
  selectedPath: string | null
  expanded: Set<string>
  contentMatches: Map<string, string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onReveal: (path: string) => void
}): React.ReactElement {
  const isDirectory = node.type === 'directory'
  const isExpanded = expanded.has(node.relativePath)
  const isActive = selectedPath === node.relativePath
  const linkState = node.linkState
  const blocked = linkState === 'unauthorized' || linkState === 'broken' || linkState === 'cycle'
  const contentExcerpt = contentMatches.get(node.relativePath)
  const paddingLeft = 8 + level * 14

  return (
    <div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={blocked}
          title={blocked ? node.blockedReason ?? '该链接指向未授权目录，请先在下方授权外置目录' : undefined}
          onClick={() => isDirectory ? onToggle(node.relativePath) : onOpen(node.relativePath)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors',
            isActive ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60',
          )}
          style={{ paddingLeft }}
        >
          {isDirectory ? (
            isExpanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
          ) : (
            <FileText size={13} className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate">{node.name}</span>
            {contentExcerpt && <span className="block truncate text-[10px] text-muted-foreground" title={contentExcerpt}>{contentExcerpt}</span>}
          </span>
          {linkState === 'authorized' && (
            <Tooltip><TooltipTrigger asChild><span className="shrink-0 text-muted-foreground/80"><Link2 size={11} /></span></TooltipTrigger><TooltipContent side="top">已授权的外置链接</TooltipContent></Tooltip>
          )}
          {blocked && (
            <Tooltip><TooltipTrigger asChild><span className="shrink-0 text-amber-600 dark:text-amber-400"><Lock size={11} /></span></TooltipTrigger><TooltipContent side="top">{linkState === 'broken' ? '链接已断裂' : linkState === 'cycle' ? '链接构成循环' : '未授权的外置链接'}</TooltipContent></Tooltip>
          )}
          {!isDirectory && node.size != null && (
            <span className="shrink-0 text-[10px] text-muted-foreground/75">{formatBytes(node.size)}</span>
          )}
        </button>
        {!isDirectory && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onReveal(node.relativePath)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`打开 ${node.name} 所在位置`}
              >
                <FolderOpen size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">打开文件所在位置</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isDirectory && isExpanded && node.children && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <MemoryTreeNode
              key={child.relativePath}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              contentMatches={contentMatches}
              onToggle={onToggle}
              onOpen={onOpen}
              onReveal={onReveal}
            />
          ))}
        </div>
      )}
    </div>
  )
}
