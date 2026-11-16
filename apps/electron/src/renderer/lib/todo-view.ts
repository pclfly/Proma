import type { TodoStatus } from '@proma/shared'

export type TodoListView = 'all' | 'today' | 'upcoming' | 'completed' | `group:${string}`

export interface TodoViewItem {
  id: string
  status: TodoStatus
  dueAt?: number
  groupId?: string
}

export function selectVisibleTodos<T extends TodoViewItem>(
  todos: T[],
  view: TodoListView,
  todayEnd: number,
  weekEnd: number,
): T[] {
  if (view === 'all') return todos.filter((todo) => todo.status === 'open')
  if (view === 'today') return todos.filter((todo) => todo.status === 'open' && todo.dueAt !== undefined && todo.dueAt <= todayEnd)
  if (view === 'upcoming') return todos.filter((todo) => todo.status === 'open' && todo.dueAt !== undefined && todo.dueAt > todayEnd && todo.dueAt <= weekEnd)
  if (view === 'completed') return todos.filter((todo) => todo.status === 'completed')
  const groupId = view.slice('group:'.length)
  return todos.filter((todo) => todo.status === 'open' && todo.groupId === groupId)
}

export interface ReorderableGroup {
  id: string
  name: string
  sortOrder: number
}

/**
 * 计算把分组上移/下移后的 sortOrder。
 *
 * 取相邻两组 sortOrder 的中点，避免批量重写其它分组；到边界时向外延伸 1。
 * 返回 undefined 表示已经在边界或分组不存在。
 */
export function getReorderedGroupSortOrder(
  groups: readonly ReorderableGroup[],
  groupId: string,
  direction: 'up' | 'down',
): number | undefined {
  const sorted = [...groups].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'),
  )
  const index = sorted.findIndex((group) => group.id === groupId)
  if (index < 0) return undefined
  const neighbor = sorted[direction === 'up' ? index - 1 : index + 1]
  if (!neighbor) return undefined
  const outer = sorted[direction === 'up' ? index - 2 : index + 2]
  return outer
    ? (neighbor.sortOrder + outer.sortOrder) / 2
    : neighbor.sortOrder + (direction === 'up' ? -1 : 1)
}
