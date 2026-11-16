/**
 * 定时任务列表视图（按项目分组）
 *
 * 由侧边栏 Automations 入口触发显示，全屏占据中间内容区（隐藏 TabBar）。
 *
 * 结构：
 * - 顶部：搜索 + 排序 + 「创建定时任务」按钮
 * - 内容：按 workspaceId 分组
 *   - 每个任务行：运行状态点 + 名称 + 调度文案 + 相对时间 + 操作菜单
 *   - 可展开运行记录：状态点、时间、耗时/错误；点击记录打开对应子会话
 * - 点击任务行 → 通过 automationFormAtom 打开编辑表单 overlay
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  ArrowUpDown,
  Check,
  ChevronRight,
  Clock,
  Folder,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Search,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import {
  automationsAtom,
  automationFormAtom,
  automationToDraft,
  createEmptyDraft,
} from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { groupAutomationsByWorkspace, hasRunningAutomationRun, type AutomationWorkspaceGroup } from '@/lib/automation-list'
import type { Automation, AutomationRun } from '@proma/shared'

/** 把调度配置格式化为可读文案 */
function formatSchedule(a: Automation): string {
  if (a.scheduleType === 'once') {
    const when = a.scheduledAt
      ? new Date(a.scheduledAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '指定时间'
    return `仅一次 ${when}`
  }
  if (a.scheduleType === 'daily') return `每天 ${a.timeOfDay ?? '09:00'}`
  if (a.scheduleType === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[a.dayOfWeek ?? 1]} ${a.timeOfDay ?? '09:00'}`
  }
  if (a.scheduleType === 'monthly') {
    const dom = a.dayOfMonth ?? 1
    // 29-31 号在短月会自动落在当月最后一天，列表里追加提示避免用户误以为漏跑
    const suffix = dom >= 29 ? '（短月落在最后一天）' : ''
    return `每月 ${dom} 号 ${a.timeOfDay ?? '09:00'}${suffix}`
  }
  const min = a.intervalMinutes
  let label: string
  if (min < 60) label = `每 ${min} 分钟`
  else if (min < 1440) label = `每 ${min / 60} 小时`
  else label = `每 ${min / 1440} 天`
  const weekdayLabel = a.activeWeekdays && a.activeWeekdays.length > 0 ? ` · ${formatWeekdays(a.activeWeekdays)}` : ''
  const windowLabel = a.activeWindowStart && a.activeWindowEnd ? ` · ${a.activeWindowStart}–${a.activeWindowEnd}` : ''
  if (weekdayLabel || windowLabel) label += `${weekdayLabel}${windowLabel}`
  // 叠加了运行次数上限时在末尾标注，让列表能看出"跑 N 次就停"
  return a.maxRuns !== undefined ? `${label}·限 ${a.maxRuns} 次` : label
}

function formatWeekdays(days?: number[]): string {
  const normalized = [...new Set(days ?? [])].sort((a, b) => a - b)
  if (normalized.length === 0) return '每天'
  if (normalized.join(',') === '1,2,3,4,5') return '工作日'
  if (normalized.join(',') === '0,6') return '周末'
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return normalized.map((day) => names[day] ?? '').join('、')
}

function formatNextRun(a: Automation): string {
  if (!a.active) return a.completedAt ? '已完成' : '已暂停'
  return `下次 ${new Date(a.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
}

/** 与 Agent 会话列表一致的相对时间（刚刚 / N 分钟前 / N 小时前 …） */
function formatRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < month) return `${Math.floor(diff / day)} 天前`
  if (diff < year) return `${Math.floor(diff / month)} 个月前`
  return `${Math.floor(diff / year)} 年前`
}

function formatRunTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

const RUN_STATUS_DOT_CLASS: Record<AutomationRun['status'], string> = {
  running: 'bg-blue-500 animate-pulse',
  success: 'bg-green-500',
  error: 'bg-red-500',
  skipped: 'bg-foreground/20',
  interrupted: 'bg-orange-500',
}

const RUN_STATUS_LABEL: Record<AutomationRun['status'], string> = {
  running: '运行中',
  success: '完成',
  error: '失败',
  skipped: '跳过',
  interrupted: '已中断',
}

/** 运行记录右侧的补充说明 */
function describeRun(run: AutomationRun): string {
  if (run.status === 'running') return '正在执行…'
  if (run.status === 'interrupted') return run.error ?? '运行被中断'
  if (run.status === 'error') return run.error ?? '失败'
  if (run.status === 'skipped') return run.skipReason ?? '跳过'
  if (run.durationMs !== undefined && run.durationMs >= 0) {
    if (run.durationMs < 60_000) return `${(run.durationMs / 1000).toFixed(1)}s`
    return `${Math.round(run.durationMs / 60_000)} 分钟`
  }
  return ''
}

interface AutomationStatusView {
  label: string
  dotClass: string
}

/** 行首运行状态点：优先反映最近一次运行，其次反映启用/完成状态 */
function describeAutomationStatus(a: Automation): AutomationStatusView {
  const latest = (a.runHistory ?? [])[0]
  if (latest?.status === 'running') return { label: '运行中', dotClass: 'bg-blue-500 animate-pulse' }
  if (!a.active) {
    return a.completedAt
      ? { label: '已完成', dotClass: 'bg-green-500/80' }
      : { label: '已暂停', dotClass: 'bg-foreground/20' }
  }
  if (latest?.status === 'error') return { label: '上次失败', dotClass: 'bg-red-500' }
  if (latest?.status === 'interrupted') return { label: '上次被中断', dotClass: 'bg-orange-500' }
  if (latest?.status === 'success') return { label: '上次成功', dotClass: 'bg-green-500' }
  return { label: '等待首次运行', dotClass: 'bg-foreground/25' }
}

/** 定时任务列表嵌入统一的任务/日程页，页头由父级提供。 */
type AutomationSortMode = 'nextRun' | 'name'

export function AutomationsListView(): React.ReactElement {
  const automations = useAtomValue(automationsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setWorkspaces = useSetAtom(agentWorkspacesAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setAutomations = useSetAtom(automationsAtom)
  const setForm = useSetAtom(automationFormAtom)
  const openSession = useOpenSession()

  const [query, setQuery] = React.useState('')
  const [sortMode, setSortMode] = React.useState<AutomationSortMode>('nextRun')
  const [expandedTaskIds, setExpandedTaskIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const [pendingDeletion, setPendingDeletion] = React.useState<Automation | null>(null)
  // 用统一时间戳刷新相对时间，避免每行独立计时
  const [relativeTimeNow, setRelativeTimeNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // 侧边栏场景下 Agent 视图可能还没加载过项目列表，按需补齐项目名
  React.useEffect(() => {
    if (workspaces.length > 0) return
    let cancelled = false
    void window.electronAPI.listAgentWorkspaces()
      .then((list) => { if (!cancelled) setWorkspaces(list) })
      .catch((error) => console.error('[定时任务] 加载项目列表失败:', error))
    return () => { cancelled = true }
  }, [workspaces.length, setWorkspaces])

  const refreshList = React.useCallback(async () => {
    const list = await window.electronAPI.listAutomations()
    setAutomations(list)
  }, [setAutomations])

  const handleCreate = (): void => {
    // 自动命名「定时任务 N」：取现有最大 X + 1
    let maxN = 0
    for (const a of automations) {
      const m = /^定时任务\s*(\d+)$/.exec(a.name.trim())
      if (m) maxN = Math.max(maxN, Number(m[1]))
    }
    const draft = createEmptyDraft()
    draft.name = `定时任务 ${maxN + 1}`
    setForm({ open: true, draft })
  }

  const handleEdit = (a: Automation): void => {
    setForm({ open: true, draft: automationToDraft(a) })
  }

  const handleRunNow = async (a: Automation): Promise<void> => {
    if (!a.channelId || !a.workspaceId) {
      toast.error('请先为该任务配置模型与项目')
      handleEdit(a)
      return
    }
    try {
      // 主进程在会话创建后立即返回启动摘要，不等待任务执行完成
      const result = await window.electronAPI.runAutomationNow(a.id)
      if (!result.started) {
        toast.warning(result.reason ?? '定时任务未能启动')
        await refreshList()
        return
      }
      toast.success(`已开始运行「${a.name}」`, {
        description: result.note ?? '任务在后台执行，展开运行记录可查看进度或打开会话',
      })
      await refreshList()
    } catch (err) {
      toast.error('运行失败')
      console.error('[定时任务] 立即运行失败:', err)
    }
  }

  const handleToggle = async (a: Automation): Promise<void> => {
    // 启用前必须配齐模型与项目，否则打开编辑面板让用户补全
    if (!a.active && (!a.channelId || !a.workspaceId)) {
      toast.error('请先为该任务配置模型与项目')
      handleEdit(a)
      return
    }
    try {
      await window.electronAPI.toggleAutomation(a.id, !a.active)
      await refreshList()
      toast.success(a.active ? '已暂停' : '已启用')
    } catch (err) {
      toast.error('操作失败')
      console.error('[定时任务] 切换状态失败:', err)
    }
  }

  const handleOpenRun = async (run: AutomationRun): Promise<void> => {
    if (!run.sessionId) {
      toast.error('这条记录没有可打开的会话')
      return
    }

    let session = agentSessions.find((item) => item.id === run.sessionId)
    if (!session) {
      try {
        const sessions = await window.electronAPI.listAgentSessions()
        setAgentSessions(sessions)
        session = sessions.find((item) => item.id === run.sessionId)
      } catch (error) {
        console.error('[定时任务] 加载会话列表失败:', error)
      }
    }
    if (!session) {
      toast.error('该会话已不存在')
      return
    }

    setActiveView('conversations')
    openSession('agent', session.id, session.title)
  }

  const toggleExpanded = (id: string): void => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmDelete = async (): Promise<void> => {
    const automation = pendingDeletion
    if (!automation) return
    try {
      await window.electronAPI.deleteAutomation(automation.id)
      await refreshList()
      setPendingDeletion(null)
      toast.success('已删除')
    } catch (error) {
      console.error('[定时任务] 删除失败:', error)
      toast.error('删除失败')
    }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filteredAutomations = React.useMemo(() => (
    normalizedQuery
      ? automations.filter((automation) => (
          automation.name.toLowerCase().includes(normalizedQuery)
          || automation.prompt.toLowerCase().includes(normalizedQuery)
        ))
      : automations
  ), [automations, normalizedQuery])

  const workspaceNames = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  )

  const compareAutomations = React.useCallback((a: Automation, b: Automation): number => {
    if (sortMode === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    return (a.nextRunAt || Number.MAX_SAFE_INTEGER) - (b.nextRunAt || Number.MAX_SAFE_INTEGER)
      || a.name.localeCompare(b.name, 'zh-CN')
  }, [sortMode])

  const groups = React.useMemo(
    () => groupAutomationsByWorkspace(filteredAutomations, workspaceNames, compareAutomations),
    [filteredAutomations, workspaceNames, compareAutomations],
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部固定创建入口 */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={handleCreate}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <Plus size={14} />
          <span>创建定时任务</span>
        </button>
      </div>
      {/* 搜索常驻；右侧独立排序按钮 */}
      <div className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted/50 px-2 text-xs text-muted-foreground">
          <Search size={13} className="shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="排序方式"
              title={sortMode === 'nextRun' ? '按下次运行时间排序' : '按名称排序'}
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <ArrowUpDown size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[100] min-w-32">
            <DropdownMenuItem onSelect={() => setSortMode('nextRun')}>
              <span className="flex-1">按下一次运行</span>
              {sortMode === 'nextRun' && <Check className="size-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSortMode('name')}>
              <span className="flex-1">按名称</span>
              {sortMode === 'name' && <Check className="size-3.5" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* 列表内容：按项目分组 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {automations.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : filteredAutomations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">未找到匹配的定时任务</p>
        ) : (
          <div className="flex w-full flex-col gap-5 pb-8">
            {groups.map((group) => (
              <AutomationGroupSection
                key={group.workspaceId || '__unassigned__'}
                group={group}
                relativeTimeNow={relativeTimeNow}
                expandedTaskIds={expandedTaskIds}
                onToggleExpanded={toggleExpanded}
                onEdit={handleEdit}
                onRunNow={(a) => { void handleRunNow(a) }}
                onToggleActive={(a) => { void handleToggle(a) }}
                onDelete={setPendingDeletion}
                onOpenRun={(run) => { void handleOpenRun(run) }}
              />
            ))}
          </div>
        )}
      </div>
      <AlertDialog open={pendingDeletion !== null} onOpenChange={(open) => { if (!open) setPendingDeletion(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认删除定时任务</AlertDialogTitle><AlertDialogDescription>删除「{pendingDeletion?.name}」后无法恢复。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">删除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface AutomationGroupSectionProps {
  group: AutomationWorkspaceGroup
  relativeTimeNow: number
  expandedTaskIds: ReadonlySet<string>
  onToggleExpanded: (id: string) => void
  onEdit: (a: Automation) => void
  onRunNow: (a: Automation) => void
  onToggleActive: (a: Automation) => void
  onDelete: (a: Automation) => void
  onOpenRun: (run: AutomationRun) => void
}

function AutomationGroupSection({
  group,
  relativeTimeNow,
  expandedTaskIds,
  onToggleExpanded,
  onEdit,
  onRunNow,
  onToggleActive,
  onDelete,
  onOpenRun,
}: AutomationGroupSectionProps): React.ReactElement {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1">
        <Folder className="size-3 shrink-0 text-foreground/35" />
        <span className="truncate text-[12px] font-medium text-foreground/55">{group.name}</span>
        {group.hasRunningRun && <span className="size-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse" title="项目中存在运行中的定时任务" />}
        <span className="shrink-0 text-[11px] tabular-nums text-foreground/30">{group.automations.length}</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
        {group.automations.map((automation, index) => (
          <AutomationRow
            key={automation.id}
            automation={automation}
            isFirst={index === 0}
            relativeTimeNow={relativeTimeNow}
            expanded={expandedTaskIds.has(automation.id) || hasRunningAutomationRun(automation)}
            onToggleExpanded={onToggleExpanded}
            onEdit={onEdit}
            onRunNow={onRunNow}
            onToggleActive={onToggleActive}
            onDelete={onDelete}
            onOpenRun={onOpenRun}
          />
        ))}
      </div>
    </section>
  )
}

interface AutomationRowProps {
  automation: Automation
  isFirst: boolean
  relativeTimeNow: number
  expanded: boolean
  onToggleExpanded: (id: string) => void
  onEdit: (a: Automation) => void
  onRunNow: (a: Automation) => void
  onToggleActive: (a: Automation) => void
  onDelete: (a: Automation) => void
  onOpenRun: (run: AutomationRun) => void
}

function AutomationRow({
  automation: a,
  isFirst,
  relativeTimeNow,
  expanded,
  onToggleExpanded,
  onEdit,
  onRunNow,
  onToggleActive,
  onDelete,
  onOpenRun,
}: AutomationRowProps): React.ReactElement {
  const status = describeAutomationStatus(a)
  const latestRunAt = a.lastRunAt ?? a.updatedAt
  // 前向版本索引可能没有 runHistory，展示层兜底为空数组
  const runHistory = a.runHistory ?? []

  return (
    <div className={cn(!isFirst && 'border-t border-border/60')}>
      {/* 行容器：用 div + role=button，避免与内部操作按钮形成嵌套 button */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onEdit(a)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onEdit(a)
          }
        }}
        className="group flex w-full cursor-pointer items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:bg-muted/50"
      >
        <span
          title={status.label}
          className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', status.dotClass)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground" title={a.prompt}>{a.name}</span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-foreground/35">
              {formatRelativeTime(latestRunAt, relativeTimeNow)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground/70">
            <span className="truncate">{formatSchedule(a)}</span>
            <span className="shrink-0">{formatNextRun(a)}</span>
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {runHistory.length > 0 && (
            <button
              type="button"
              aria-label={expanded ? `收起 ${a.name} 的运行记录` : `展开 ${a.name} 的运行记录`}
              title={expanded ? '收起运行记录' : '展开运行记录'}
              onClick={() => onToggleExpanded(a.id)}
              className="flex items-center gap-0.5 rounded-md px-1 py-1 text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
              <span className="text-[10px] tabular-nums">{runHistory.length}</span>
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${a.name} 操作`}
                className="flex size-6 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70 data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground/70"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[100] min-w-40">
              <DropdownMenuItem onSelect={() => onRunNow(a)}>
                <Play className="size-3.5" />
                <span>立即运行</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onEdit(a)}>
                <Pencil className="size-3.5" />
                <span>编辑任务</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onToggleActive(a)}>
                {a.active ? <Pause className="size-3.5" /> : <Power className="size-3.5" />}
                <span>{a.active ? '暂停任务' : '启用任务'}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onDelete(a)} className="text-destructive focus:text-destructive">
                <Trash2 className="size-3.5" />
                <span>删除任务</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border/40 bg-muted/20 px-3 py-1">
          {runHistory.length === 0 ? (
            <p className="py-1 text-[11px] text-muted-foreground/60">暂无运行记录</p>
          ) : (
            runHistory.slice(0, 10).map((run, index) => {
              const hasSession = !!run.sessionId
              return (
                <button
                  key={run.runId || `${run.runAt}-${index}`}
                  type="button"
                  onClick={() => onOpenRun(run)}
                  disabled={!hasSession}
                  title={hasSession ? '打开该次运行的会话' : '这条记录没有可打开的会话'}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[11px] transition-colors enabled:hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', RUN_STATUS_DOT_CLASS[run.status])} />
                  <span className="shrink-0 tabular-nums text-foreground/45">{formatRunTime(run.runAt)}</span>
                  <span className="shrink-0 text-foreground/55">{RUN_STATUS_LABEL[run.status]}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/35">{describeRun(run)}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-[240px] flex-col items-center pt-20 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-foreground/[0.05]">
        <Clock className="size-5 text-foreground/35" />
      </div>
      <div className="mt-4 text-[13px] font-medium text-foreground/85">还没有定时任务</div>
      <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground/60">
        让 Proma 定期执行检查、汇总与跟进工作。
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-[12px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
      >
        <Plus size={13} />
        <span>新建定时任务</span>
      </button>
    </div>
  )
}
