/**
 * QuickCaptureTodoApp — 清单全局快速捕获浮层。
 *
 * 官方 0.22.0：Cmd/Ctrl+Shift+T 在任意应用下唤起；输入标题后回车直接落到清单，
 * 可选分组、优先级与截止日期。窗口失焦自动隐藏。
 */

import React from 'react'
import type { PlanningGroup, TodoPriority } from '@proma/shared'

const PRIORITY_OPTIONS: Array<{ value: TodoPriority; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export function QuickCaptureTodoApp(): React.ReactElement {
  const [title, setTitle] = React.useState('')
  const [priority, setPriority] = React.useState<TodoPriority>('medium')
  const [groupId, setGroupId] = React.useState('')
  const [dueDate, setDueDate] = React.useState('')
  const [groups, setGroups] = React.useState<PlanningGroup[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
  }, [])

  const loadGroups = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.listPlanningGroups('todo')
      setGroups(result)
    } catch {
      setGroups([])
    }
  }, [])

  const reset = React.useCallback((): void => {
    setTitle('')
    setPriority('medium')
    setGroupId('')
    setDueDate('')
    setError(null)
    setSubmitting(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  React.useEffect(() => {
    reset()
    void loadGroups()
    const cleanup = window.electronAPI.onQuickCaptureTodoFocus(() => {
      reset()
      void loadGroups()
    })
    return cleanup
  }, [loadGroups, reset])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.electronAPI.hideQuickCaptureTodo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const dueAt = dueDate
        ? new Date(`${dueDate}T23:59:59`).getTime()
        : undefined
      await window.electronAPI.createTodo({
        title: trimmed,
        priority,
        ...(groupId ? { groupId } : {}),
        ...(dueAt !== undefined && Number.isFinite(dueAt) ? { dueAt } : {}),
      })
      reset()
      await window.electronAPI.hideQuickCaptureTodo()
    } catch (submitError) {
      setSubmitting(false)
      setError(submitError instanceof Error ? submitError.message : '保存失败，请重试')
    }
  }

  return (
    <div className="flex w-full flex-col rounded-2xl border border-border/40 bg-background shadow-2xl">
      <div className="flex items-center justify-between px-4 pt-3 text-[11px] text-muted-foreground">
        <span>快速捕获到清单</span>
        <span>Esc 关闭 · Enter 保存</span>
      </div>

      <input
        ref={inputRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder="要做什么？"
        className="mx-3 mt-2 rounded-lg border-0 bg-muted/40 px-3 py-3 text-[15px] outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-primary/40"
        aria-label="清单标题"
      />

      <div className="mx-3 mt-2 flex items-center gap-2">
        <select
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/40 bg-background px-2 text-xs text-foreground outline-none"
          aria-label="分组"
        >
          <option value="">无分组</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>

        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value as TodoPriority)}
          className="h-8 w-20 rounded-md border border-border/40 bg-background px-2 text-xs text-foreground outline-none"
          aria-label="优先级"
        >
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>

        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="h-8 w-32 rounded-md border border-border/40 bg-background px-2 text-xs text-foreground outline-none"
          aria-label="截止日期"
        />

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!title.trim() || submitting}
          className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
