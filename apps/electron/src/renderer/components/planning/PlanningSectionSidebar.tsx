/**
 * 清单分区侧栏（官方 0.22.0 左侧第二列）。
 *
 * 导航、分组管理与排序/换色/删除都留在这里；PlanningView 只负责列表与详情。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronRight,
  ListTodo,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { PlanningGroup, Todo } from '@proma/shared'
import { planningSelectedTodoIdAtom, planningTodoViewAtom, todoPlanningGroupsAtom, todosAtom } from '@/atoms/planning-atoms'
import { GROUP_COLORS, PlanningGroupManager } from '@/components/planning/PlanningGroupManager'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { getReorderedGroupSortOrder, type TodoListView } from '@/lib/todo-view'
import { cn } from '@/lib/utils'

function endOfToday(value: number | Date = Date.now()): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
}

function addLocalDays(value: number, amount: number): number {
  const date = new Date(value)
  date.setDate(date.getDate() + amount)
  return date.getTime()
}

export function PlanningSectionSidebar(): React.ReactElement {
  const todos = useAtomValue(todosAtom)
  const [groups, setGroups] = useAtom(todoPlanningGroupsAtom)
  const setTodos = useSetAtom(todosAtom)
  const [view, setView] = useAtom(planningTodoViewAtom)
  const setSelectedId = useSetAtom(planningSelectedTodoIdAtom)

  const [contextRenameGroup, setContextRenameGroup] = React.useState<PlanningGroup | null>(null)
  const [contextRenameDraft, setContextRenameDraft] = React.useState('')
  const [contextDeleteGroup, setContextDeleteGroup] = React.useState<PlanningGroup | null>(null)

  const todayEnd = React.useMemo(() => endOfToday(), [])
  const weekEnd = React.useMemo(() => endOfToday(addLocalDays(Date.now(), 7)), [])
  const openTodos = React.useMemo(() => todos.filter((todo) => todo.status === 'open'), [todos])
  const groupUsageCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const todo of todos) {
      if (!todo.groupId) continue
      counts.set(todo.groupId, (counts.get(todo.groupId) ?? 0) + 1)
    }
    return counts
  }, [todos])
  const groupHasItems = React.useMemo(
    () => new Set(todos.flatMap((todo) => todo.groupId ? [todo.groupId] : [])),
    [todos],
  )

  const sortGroups = React.useCallback((items: PlanningGroup[]): PlanningGroup[] => (
    [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
  ), [])

  const createGroup = React.useCallback(async (name: string): Promise<PlanningGroup | undefined> => {
    try {
      const group = await window.electronAPI.createPlanningGroup({ scope: 'todo', name })
      setGroups((items) => sortGroups([...items, group]))
      return group
    } catch (error) {
      console.error('[清单侧栏] 创建分组失败:', error)
      toast.error('创建清单分组失败：名称可能已存在')
      return undefined
    }
  }, [setGroups, sortGroups])

  const renameGroup = React.useCallback(async (group: PlanningGroup, name: string): Promise<PlanningGroup | undefined> => {
    try {
      const updated = await window.electronAPI.updatePlanningGroup({ id: group.id, scope: 'todo', name })
      if (!updated) throw new Error('分组不存在')
      setGroups((items) => items.map((item) => item.id === updated.id ? updated : item))
      setTodos((items) => items.map((item) => item.groupId === updated.id ? { ...item, group: updated } : item))
      return updated
    } catch (error) {
      console.error('[清单侧栏] 重命名分组失败:', error)
      toast.error('重命名清单分组失败：名称可能已存在')
      return undefined
    }
  }, [setGroups, setTodos])

  const reorderGroup = React.useCallback(async (group: PlanningGroup, direction: 'up' | 'down'): Promise<void> => {
    const nextOrder = getReorderedGroupSortOrder(sortGroups(groups), group.id, direction)
    if (nextOrder === undefined) return
    try {
      const updated = await window.electronAPI.updatePlanningGroup({ id: group.id, scope: 'todo', sortOrder: nextOrder })
      if (!updated) return
      setGroups((items) => sortGroups(items.map((item) => item.id === updated.id ? updated : item)))
    } catch (error) {
      console.error('[清单侧栏] 调整分组顺序失败:', error)
      toast.error('调整清单分组顺序失败')
    }
  }, [groups, setGroups, sortGroups])

  const setGroupColor = React.useCallback(async (group: PlanningGroup, color: string | null): Promise<void> => {
    try {
      const updated = await window.electronAPI.updatePlanningGroup({ id: group.id, scope: 'todo', color })
      if (!updated) return
      setGroups((items) => items.map((item) => item.id === updated.id ? updated : item))
      setTodos((items) => items.map((item) => item.groupId === updated.id ? { ...item, group: updated } : item))
    } catch (error) {
      console.error('[清单侧栏] 修改分组颜色失败:', error)
      toast.error('修改清单分组颜色失败')
    }
  }, [setGroups, setTodos])

  const deleteGroup = React.useCallback(async (group: PlanningGroup): Promise<boolean> => {
    try {
      const deleted = await window.electronAPI.deletePlanningGroup('todo', group.id)
      if (!deleted) throw new Error('分组不存在')
      setGroups((items) => items.filter((item) => item.id !== group.id))
      setTodos((items) => items.map((item) => item.groupId === group.id ? { ...item, groupId: undefined, group: undefined } : item))
      setView((current) => current === `group:${group.id}` ? 'all' : current)
      return true
    } catch (error) {
      console.error('[清单侧栏] 删除分组失败:', error)
      toast.error('删除清单分组失败')
      return false
    }
  }, [setGroups, setTodos, setView])

  const count = (predicate: (todo: Todo) => boolean): number => openTodos.filter(predicate).length
  const navItems: Array<{ id: TodoListView; label: string; icon: React.ReactNode; count?: number }> = [
    { id: 'all', label: '全部任务', icon: <ListTodo size={15} />, count: openTodos.length },
    { id: 'today', label: '今天', icon: <CalendarDays size={15} />, count: count((todo) => todo.dueAt !== undefined && todo.dueAt <= todayEnd) },
    { id: 'upcoming', label: '未来 7 天', icon: <ChevronRight size={15} />, count: count((todo) => todo.dueAt !== undefined && todo.dueAt > todayEnd && todo.dueAt <= weekEnd) },
    { id: 'completed', label: '已完成', icon: <Check size={15} /> },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-2 scrollbar-thin">
      <nav className="space-y-1" aria-label="清单导航">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors',
              view === item.id
                ? 'bg-foreground/[0.075] font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
            )}
          >
            <span className="text-muted-foreground">{item.icon}</span>
            <span className="flex-1 text-left">{item.label}</span>
            {item.count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{item.count}</span>}
          </button>
        ))}
      </nav>

      <div className="mt-7">
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">清单分组</span>
          <PlanningGroupManager
            scope="todo"
            groups={groups}
            itemLabel="Todo"
            getUsageCount={(groupId) => groupUsageCounts.get(groupId) ?? 0}
            hasAssociatedItems={(groupId) => groupHasItems.has(groupId)}
            showDeletionCount={false}
            onCreate={createGroup}
            onRename={renameGroup}
            onDelete={deleteGroup}
            onReorder={reorderGroup}
            onSetColor={setGroupColor}
            onCreated={(group) => setView(`group:${group.id}`)}
            trigger={
              <button
                type="button"
                aria-label="管理清单分组"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus size={14} />
              </button>
            }
          />
        </div>
        <div className="space-y-1">
          {groups.map((group, groupIndex) => {
            const id = `group:${group.id}` as TodoListView
            return (
              <ContextMenu key={group.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setView(id)}
                    className={cn(
                      'flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors',
                      view === id
                        ? 'bg-foreground/[0.075] font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: group.color ?? 'currentColor' }} />
                    <span className="flex-1 truncate text-left">{group.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{groupUsageCounts.get(group.id) ?? 0}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  <ContextMenuItem onSelect={() => { setContextRenameGroup(group); setContextRenameDraft(group.name) }}><Pencil />重命名</ContextMenuItem>
                  <ContextMenuItem disabled={groupIndex === 0} onSelect={() => void reorderGroup(group, 'up')}><ArrowUp />上移</ContextMenuItem>
                  <ContextMenuItem disabled={groupIndex === groups.length - 1} onSelect={() => void reorderGroup(group, 'down')}><ArrowDown />下移</ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger><Palette />颜色</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-44">
                      <div className="flex flex-wrap gap-1.5 px-2 py-1.5">
                        {GROUP_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={`设置分组颜色 ${color}`}
                            className={cn('size-4 rounded-full border border-black/10', group.color === color && 'ring-2 ring-ring ring-offset-1')}
                            style={{ backgroundColor: color }}
                            onClick={() => void setGroupColor(group, color)}
                          />
                        ))}
                        <button type="button" className="w-full pt-1 text-left text-[10px] text-muted-foreground underline underline-offset-2" onClick={() => void setGroupColor(group, null)}>恢复默认颜色</button>
                      </div>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => setContextDeleteGroup(group)}><Trash2 />删除分组</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>

      <Dialog open={contextRenameGroup !== null} onOpenChange={(open) => { if (!open) setContextRenameGroup(null) }}>
        <DialogContent className="max-w-sm">
          <DialogTitle>重命名分组</DialogTitle>
          <Input
            autoFocus
            value={contextRenameDraft}
            onChange={(event) => setContextRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                const group = contextRenameGroup
                if (!group || !contextRenameDraft.trim()) return
                void renameGroup(group, contextRenameDraft).then((updated) => { if (updated) setContextRenameGroup(null) })
              } else if (event.key === 'Escape') {
                setContextRenameGroup(null)
              }
            }}
            placeholder="分组名称"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setContextRenameGroup(null)}>取消</Button>
            <Button
              type="button"
              disabled={!contextRenameDraft.trim()}
              onClick={() => {
                const group = contextRenameGroup
                if (!group || !contextRenameDraft.trim()) return
                void renameGroup(group, contextRenameDraft).then((updated) => { if (updated) setContextRenameGroup(null) })
              }}
            >
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={contextDeleteGroup !== null} onOpenChange={(open) => { if (!open) setContextDeleteGroup(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除分组</AlertDialogTitle>
            <AlertDialogDescription>删除「{contextDeleteGroup?.name}」后，关联 Todo 会变为未分组，内容不会删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const group = contextDeleteGroup
                if (!group) return
                void deleteGroup(group).then((deleted) => { if (deleted) setContextDeleteGroup(null) })
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
