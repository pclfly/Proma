import type { ToolActivity } from '@/atoms/agent-atoms'

/** 可见进度工具名集合（用于聚合判断，与 SDKMessageRenderer 共享语义）。 */
export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate'])

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'error' | 'deleted'

/** Claude SDK 与 Pi 兼容任务工具共用的终态集合。 */
export function isTerminalTaskStatus(status: TaskItemStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error' || status === 'deleted'
}

export interface TaskItem {
  id: string
  subject: string
  status: TaskItemStatus
  activeForm?: string
}

/**
 * 全部任务进度展示共用的统计口径。
 *
 * `completed` 是成功完成数；`terminal` 用于判断是否仍有任务活动，不能当作完成数展示。
 *
 * 分母口径：`cancelled` 从分母剔除。被取消的任务是"不做了"，把它计入分母会让
 * 分子永远填不满，进度条长期停在 0/N，看起来像卡死。
 * `error` 保留在分母——失败需要被看见，不能靠剔除来掩盖。
 */
export function getTaskProgressCounts(items: TaskItem[]): {
  completed: number
  terminal: number
  total: number
  hasActive: boolean
} {
  const denominator = items.filter((item) => item.status !== 'cancelled')
  const completed = denominator.filter((item) => item.status === 'completed').length
  const terminal = denominator.filter((item) => isTerminalTaskStatus(item.status)).length
  return {
    completed,
    terminal,
    total: denominator.length,
    hasActive: terminal < denominator.length,
  }
}

interface TaskCreateOutput {
  task?: {
    id?: unknown
    subject?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * SDK tool_result content can be a raw string or an array of text blocks.
 * Keep this extraction narrow so binary/image blocks do not leak into task parsing.
 */
export function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined

  const text = content
    .map((block) => {
      if (!isRecord(block)) return ''
      return typeof block.text === 'string' ? block.text : ''
    })
    .join('')

  return text || undefined
}

export function parseTaskCreateResult(result: string | undefined): { id: string; subject?: string } | null {
  if (!result) return null

  const json = parseJsonObject(result) as TaskCreateOutput | null
  const task = json?.task
  if (isRecord(task) && (typeof task.id === 'string' || typeof task.id === 'number')) {
    return {
      id: String(task.id),
      subject: typeof task.subject === 'string' ? task.subject : undefined,
    }
  }

  return null
}

function toTaskStatus(value: unknown, fallback: TaskItemStatus = 'pending'): TaskItemStatus {
  if (
    value === 'pending'
    || value === 'in_progress'
    || value === 'completed'
    || value === 'blocked'
    || value === 'cancelled'
    || value === 'error'
    || value === 'deleted'
  ) {
    return value
  }
  return fallback
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function taskIdFromInput(input: Record<string, unknown>): string | undefined {
  return stringId(input.taskId ?? input.task_id ?? input.id)
}

/**
 * 从 ToolActivity[] 中提取并聚合所有任务项的最新状态。
 *
 * 策略：
 * 1. TaskCreate 读取 SDK 0.3 的结构化输出 `{ task: { id, subject } }`
 * 2. TaskUpdate 通过 taskId 更新已有条目，跨 turn 时可用历史 subject 恢复任务名
 */
export function aggregateTaskItems(
  activities: ToolActivity[],
  streamEnded: boolean,
  historicalTaskSubjects?: Map<string, string>,
): TaskItem[] {
  const taskMap = new Map<string, TaskItem>()

  const taskCreateIdMap = new Map<string, string>()
  const taskCreateSubjectMap = new Map<string, string>()

  /**
   * id 别名表：真实任务 id 与 toolUseId 互相映射。
   *
   * 背景：TaskCreate 的真实 id 来自 tool_result。流式过程中或结果被丢弃时拿不到，
   * 任务会先以 toolUseId 作为 id 落库；之后 Agent 用真实 id 发 TaskUpdate 就会匹配不上，
   * 从而新建一条孤立任务，把分母撑大、完成数永远追不上（表现为 "0/N 一直不变"）。
   *
   * 因此这里把两者登记为同一任务的别名，无论后续用哪个 id 更新都能命中同一条目。
   */
  const aliasToCanonical = new Map<string, string>()
  /** 缺 result 时按创建顺序推断 id 的计数器（与官方自增序号一致）。 */
  let createSeq = 0
  const canonicalTaskKey = (id: string): string => {
    let current = id
    const seen = new Set<string>()
    while (aliasToCanonical.has(current) && !seen.has(current)) {
      seen.add(current)
      current = aliasToCanonical.get(current)!
    }
    return current
  }
  const linkAlias = (alias: string, canonical: string): void => {
    if (alias === canonical) return
    // 两个已有条目合并时，把旧条目并入新条目前先记录别名。
    aliasToCanonical.set(alias, canonical)
    aliasToCanonical.set(canonicalTaskKey(canonical), canonical)
  }

  // 按 activities 原顺序单遍处理：TaskCreate 与 TaskUpdate 的先后关系有语义
  // （缺 result 的 create 需要与更早出现的"未知 id 更新"配对），不能拆成两遍。
  for (const activity of activities) {
    if (activity.toolName === 'TaskCreate') {
      const parsedResult = parseTaskCreateResult(activity.result)
      /**
       * 缺 result 时的 id 推断。
       *
       * 官方 TaskCreate 的 id 来自「输入显式 id」或「进程内自增序号」，因此缺 result
       * 时用创建顺序号比 toolUseId 更接近真实 id：Agent 后续通常按 1、2、3… 发 TaskUpdate。
       * 用 toolUseId 会让后续按真实 id 的更新匹配不上，从而新建孤立条目、撑大分母。
       */
      createSeq += 1
      const inferredId = typeof activity.input.id === 'string' || typeof activity.input.taskId === 'string'
        ? String(activity.input.id ?? activity.input.taskId)
        : String(createSeq)
      const resolvedId = parsedResult?.id ?? inferredId
      taskCreateIdMap.set(activity.toolUseId, resolvedId)
      // 真实 id 与 toolUseId 视为同一任务，两条路都能命中。
      linkAlias(activity.toolUseId, resolvedId)
      if (parsedResult?.subject) taskCreateSubjectMap.set(resolvedId, parsedResult.subject)
      const rawId = resolvedId
      // 同一任务可能先以 toolUseId 落库、后拿到真实 id；统一归到 canonical key，避免重复条目。
      const id = canonicalTaskKey(rawId)
      const subject = typeof activity.input.subject === 'string'
        ? activity.input.subject
        : taskCreateSubjectMap.get(rawId)
          ?? taskCreateSubjectMap.get(id)
          ?? (typeof activity.input.description === 'string' ? activity.input.description : '未命名任务')

      // 若此前已用另一个别名登记过该任务，保留其已有状态而不是重置为 pending。
      const existingByAlias = taskMap.get(rawId) ?? taskMap.get(id)
      if (existingByAlias && existingByAlias.id !== id) taskMap.delete(existingByAlias.id)

      taskMap.set(id, {
        id,
        subject,
        status: existingByAlias?.status ?? 'pending',
        activeForm: typeof activity.input.activeForm === 'string'
          ? activity.input.activeForm
          : existingByAlias?.activeForm,
      })
    } else if (activity.toolName === 'TaskUpdate') {
      const rawTaskId = taskIdFromInput(activity.input)
      if (!rawTaskId) continue
      const taskId = canonicalTaskKey(rawTaskId)

      const existing = taskMap.get(taskId) ?? taskMap.get(rawTaskId)
      const status = toTaskStatus(activity.input.status, existing?.status ?? 'pending')

      if (existing) {
        taskMap.set(taskId, {
          ...existing,
          status,
          ...(typeof activity.input.subject === 'string' && { subject: activity.input.subject }),
          ...(typeof activity.input.activeForm === 'string' && { activeForm: activity.input.activeForm }),
        })
      } else {
        taskMap.set(taskId, {
          id: taskId,
          subject: typeof activity.input.subject === 'string'
            ? activity.input.subject
            : historicalTaskSubjects?.get(taskId) ?? `任务 #${taskId}`,
          status,
          activeForm: typeof activity.input.activeForm === 'string' ? activity.input.activeForm : undefined,
        })
      }
    }
  }

  let items = Array.from(taskMap.values()).filter((t) => t.status !== 'deleted')
  if (streamEnded) {
    items = items.map((t) =>
      t.status === 'in_progress'
        ? { ...t, status: 'pending' as const, activeForm: undefined }
        : t
    )
  }
  return items
}
