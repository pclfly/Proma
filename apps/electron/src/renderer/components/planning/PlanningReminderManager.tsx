/**
 * 提醒管理面板：新建、编辑时间、删除与历史查看。
 *
 * 与 PlanningReminderRail 的分工：
 * - Rail 只处理"已到期、需要立刻响应"的提醒（确认 / 推迟）
 * - 本面板处理"主动管理"：给某个 Todo 或日程加提醒、改时间、删掉、回看历史
 *
 * 所有时间在前端按本地时区解释，提交时转成绝对时间戳。
 */

import * as React from 'react'
import type { PlanningReminder, PlanningReminderTargetType } from '@proma/shared'
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface PlanningReminderManagerProps {
  targetType: PlanningReminderTargetType
  targetId: string
  /** 目标当前内容，用于提示"提醒会挂在谁身上"。 */
  targetTitle: string
}

/** 常用时间的一键选项，按"从现在起"计算。 */
const QUICK_OFFSETS: Array<{ label: string; minutes: number }> = [
  { label: '30 分钟后', minutes: 30 },
  { label: '1 小时后', minutes: 60 },
  { label: '明天此时', minutes: 24 * 60 },
  { label: '3 天后', minutes: 3 * 24 * 60 },
]

/** 把绝对时间戳格式化为本地 `YYYY-MM-DD HH:mm`，供 datetime-local 使用。 */
export function formatReminderDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** datetime-local 的值转绝对时间戳；非法输入返回 undefined，绝不回退到"现在"。 */
export function parseReminderDateTime(value: string): number | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  const timestamp = parsed.getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function reminderStatusLabel(reminder: PlanningReminder): string {
  if (reminder.status === 'acknowledged') return '已关闭'
  if (reminder.status === 'completed') return '已完成'
  return reminder.snoozedUntil ? '已推迟' : '待提醒'
}

export function PlanningReminderManager({ targetType, targetId, targetTitle }: PlanningReminderManagerProps): React.ReactElement {
  const [reminders, setReminders] = React.useState<PlanningReminder[]>([])
  const [loading, setLoading] = React.useState(false)
  const [draftAt, setDraftAt] = React.useState<string>('')
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editingAt, setEditingAt] = React.useState<string>('')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setReminders(await window.electronAPI.listPlanningReminders({ targetType, targetId }))
    } catch (error) {
      console.error('[提醒管理] 加载失败:', error)
      toast.error(error instanceof Error ? error.message : '加载提醒失败')
    } finally {
      setLoading(false)
    }
  }, [targetId, targetType])

  React.useEffect(() => { void refresh() }, [refresh])

  const create = async (triggerAt: number): Promise<void> => {
    try {
      await window.electronAPI.createPlanningReminder({ targetType, targetId, triggerAt })
      setDraftAt('')
      await refresh()
      toast.success('提醒已创建')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建提醒失败')
    }
  }

  const saveEdit = async (id: string): Promise<void> => {
    const triggerAt = parseReminderDateTime(editingAt)
    if (triggerAt === undefined) {
      toast.error('提醒时间非法')
      return
    }
    try {
      await window.electronAPI.updatePlanningReminder(id, triggerAt)
      setEditingId(null)
      await refresh()
      toast.success('提醒时间已更新')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改提醒失败')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      const deleted = await window.electronAPI.deletePlanningReminder(id)
      if (!deleted) {
        toast.error('提醒不存在或已删除')
        return
      }
      await refresh()
      toast.success('提醒已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除提醒失败')
    }
  }

  return (
    <section className="rounded-lg border border-border/60 p-3" aria-label="提醒管理">
      <header className="mb-2 flex items-center gap-2">
        <Bell size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-medium">提醒</h3>
        <span className="min-w-0 truncate text-xs text-muted-foreground">· {targetTitle}</span>
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {QUICK_OFFSETS.map((option) => (
          <Button
            key={option.minutes}
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void create(Date.now() + option.minutes * 60_000)}
          >
            + {option.label}
          </Button>
        ))}
        <input
          type="datetime-local"
          value={draftAt}
          onChange={(event) => setDraftAt(event.target.value)}
          className="h-7 rounded-md border border-border/60 bg-transparent px-2 text-xs"
          aria-label="自定义提醒时间"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="按自定义时间创建提醒"
          onClick={() => {
            const triggerAt = parseReminderDateTime(draftAt)
            if (triggerAt === undefined) {
              toast.error('请先选择提醒时间')
              return
            }
            void create(triggerAt)
          }}
        >
          <Plus size={13} />
        </Button>
      </div>

      {loading && <p role="status" className="text-xs text-muted-foreground">正在加载…</p>}
      {!loading && reminders.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <BellOff size={12} />还没有提醒
        </p>
      )}

      <ul className="space-y-1">
        {reminders.map((reminder) => (
          <li key={reminder.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
            {editingId === reminder.id ? (
              <>
                <input
                  type="datetime-local"
                  value={editingAt}
                  onChange={(event) => setEditingAt(event.target.value)}
                  className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-transparent px-1.5 text-xs"
                  aria-label="编辑提醒时间"
                />
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => void saveEdit(reminder.id)}>保存</Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setEditingId(null)}>取消</Button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {formatReminderDateTime(reminder.snoozedUntil ?? reminder.triggerAt).replace('T', ' ')}
                  {' · '}
                  {reminderStatusLabel(reminder)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs"
                  onClick={() => { setEditingId(reminder.id); setEditingAt(formatReminderDateTime(reminder.triggerAt)) }}
                >
                  改时间
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-destructive"
                  aria-label="删除提醒"
                  onClick={() => void remove(reminder.id)}
                >
                  <Trash2 size={12} />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
