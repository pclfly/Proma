/**
 * 协作委派结果投影。
 *
 * 官方 0.22.0 把「列表/等待/精读」的结果裁剪收敛为纯函数：
 * - metadata 只返回身份、状态、目标/错误预览和阻塞问题；
 * - preview 在总字符预算内公平分配正文；
 * - 当前 scope 只认依赖中记录的 attempt，续跑替换后旧 attempt 显示 interrupted。
 *
 * 投影从不修改原始结果；预算按 UTF-16 字符数计算，不冒充 token。
 */

import type {
  AgentCollaborationAttemptSnapshot,
  AgentCollaborationDependency,
} from '@proma/shared'

export const DEFAULT_COLLABORATION_RESULT_CHARS = 12_000
export const MAX_COLLABORATION_RESULT_CHARS = 50_000
export const DEFAULT_DELEGATION_LIST_LIMIT = 20
export const MAX_DELEGATION_LIST_LIMIT = 100
export const MAX_COLLABORATION_BLOCKER_CHARS = 4_000
export const GOAL_PREVIEW_CHAR_LIMIT = 500
export const ERROR_PREVIEW_CHAR_LIMIT = 2_000
export const MAX_BLOCKERS_PER_PROJECTION = 10
export const MAX_QUESTIONS_PER_PROJECTION = 10
export const MAX_OPTIONS_PER_PROJECTION = 20

export type DelegationResultDetail = 'metadata' | 'preview' | 'full'

export interface DelegationResultLike {
  delegationId: string
  attemptId?: string
  parentSessionId?: string
  childSessionId?: string
  channelId?: string
  modelId?: string
  thinkingLevel?: string
  thinkingLevelSemantics?: string
  title?: string
  role?: string
  goal?: string
  status: string
  startedAt: number
  completedAt?: number
  error?: string
  resultSummary?: string
  pendingBlockedEvents?: unknown[]
  [key: string]: unknown
}

export interface DelegationResultProjectionOptions {
  detail: DelegationResultDetail
  maxResultChars: number
}

export interface DelegationResultReadOptions {
  detail?: 'preview' | 'full'
  maxResultChars?: number
}

export interface DelegationResultReadSelection {
  detail: 'preview' | 'full'
  maxResultChars: number
}

export interface DelegationCurrentScopeSelectionInput<T extends DelegationResultLike> {
  scope: 'current' | 'history'
  dependencies: AgentCollaborationDependency[]
  all: T[]
  includeCompleted: boolean
}

export interface DelegationPaginationOptions {
  cursor?: string
  limit?: number
  order?: 'input' | 'newest-first'
}

export interface DelegationPage<T> {
  items: T[]
  totalCount: number
  nextCursor?: string
}

interface BlockerBudget {
  remainingChars: number
  remainingEvents: number
  remainingQuestions: number
  remainingOptions: number
}

interface BlockerRecord {
  [key: string]: unknown
}

function asRecord(value: unknown): BlockerRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as BlockerRecord
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 校验并归一化单次结果读取的正文预算。 */
export function normalizeDelegationResultCharBudget(maxResultChars: number): number {
  if (
    !Number.isInteger(maxResultChars)
    || maxResultChars < 0
    || maxResultChars > MAX_COLLABORATION_RESULT_CHARS
  ) {
    throw new Error(`maxResultChars 必须是 0 到 ${MAX_COLLABORATION_RESULT_CHARS} 的整数`)
  }
  return maxResultChars
}

/** 校验单次结果读取参数；full 只允许读取一个 delegation。 */
export function validateDelegationResultReadOptions(
  input: DelegationResultReadOptions & { delegationCount: number },
): DelegationResultReadSelection {
  const detail = input.detail ?? 'preview'
  if (detail === 'full' && input.delegationCount !== 1) {
    throw new Error('detail=full 只能读取一个 delegationId')
  }
  return {
    detail,
    maxResultChars: normalizeDelegationResultCharBudget(
      input.maxResultChars
        ?? (detail === 'full' ? MAX_COLLABORATION_RESULT_CHARS : DEFAULT_COLLABORATION_RESULT_CHARS),
    ),
  }
}

/** 校验列表分页大小。 */
export function normalizeDelegationListLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_DELEGATION_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELEGATION_LIST_LIMIT) {
    throw new Error(`limit 必须是 1 到 ${MAX_DELEGATION_LIST_LIMIT} 的整数`)
  }
  return limit
}

/**
 * 把一条结果投影为 metadata 或带预算的 preview。
 * 阻塞问题与正文共享独立的字符/条目预算，防止单个问题撑爆工具结果。
 */
export function projectDelegationResults<T extends DelegationResultLike>(
  results: readonly T[],
  options: DelegationResultProjectionOptions,
): Array<Record<string, unknown>> {
  const maxResultChars = normalizeDelegationResultCharBudget(options.maxResultChars)
  const blockerBudget: BlockerBudget = {
    remainingChars: MAX_COLLABORATION_BLOCKER_CHARS,
    remainingEvents: MAX_BLOCKERS_PER_PROJECTION,
    remainingQuestions: MAX_QUESTIONS_PER_PROJECTION,
    remainingOptions: MAX_OPTIONS_PER_PROJECTION,
  }
  const projected = results.map((result) => toMetadataView(result, blockerBudget))
  if (options.detail === 'metadata') return projected

  const allocations = allocatePreviewChars(
    results.map((result) => result.resultSummary?.length ?? 0),
    maxResultChars,
  )
  return projected.map((result, index) => {
    const summary = results[index]?.resultSummary
    if (summary === undefined) return result
    const previewChars = allocations[index] ?? 0
    return {
      ...result,
      resultSummary: summary.slice(0, previewChars),
      resultSummaryTruncated: previewChars < summary.length,
    }
  })
}

/** current scope 按依赖顺序返回；history 返回全部结果。 */
export function selectDelegationResults<T extends DelegationResultLike>(
  input: DelegationCurrentScopeSelectionInput<T>,
): T[] {
  const selected = input.scope === 'current'
    ? selectCurrentScopeResults(input.all, input.dependencies) as T[]
    : [...input.all]
  return input.includeCompleted ? selected : selected.filter((result) => result.status === 'running')
}

/** 列表分页：input 顺序用 offset 游标，history 用 startedAt+delegationId 游标。 */
export function paginateDelegationResults<T extends DelegationResultLike>(
  results: readonly T[],
  options: DelegationPaginationOptions = {},
): DelegationPage<T> {
  const limit = normalizeDelegationListLimit(options.limit)
  const ordered = options.order === 'newest-first'
    ? [...results].sort(compareDelegationNewestFirst)
    : [...results]
  if (options.order === 'newest-first') {
    const cursor = parseDelegationHistoryCursor(options.cursor)
    const remaining = cursor ? ordered.filter((result) => isAfterHistoryCursor(result, cursor)) : ordered
    const items = remaining.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      totalCount: ordered.length,
      nextCursor: last && items.length < remaining.length
        ? formatDelegationHistoryCursor(last)
        : undefined,
    }
  }
  const offset = parseDelegationOffset(options.cursor)
  const items = ordered.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  return {
    items,
    totalCount: ordered.length,
    nextCursor: nextOffset < ordered.length ? String(nextOffset) : undefined,
  }
}

/**
 * 当前 scope 只信任依赖中记录的 attempt。
 * 如果同一个 delegation 已被续跑替换，按依赖快照重建 interrupted 视图，而不是回传新 attempt。
 */
export function selectCurrentScopeResults(
  all: readonly DelegationResultLike[],
  dependencies: readonly AgentCollaborationDependency[],
): DelegationResultLike[] {
  const byDelegationId = new Map(all.map((result) => [result.delegationId, result]))
  return dependencies.flatMap((dependency) => {
    const result = byDelegationId.get(dependency.delegationId)
    if (!result) return []
    return result.attemptId === dependency.attemptId
      ? [result]
      : [asInterruptedDelegationAttempt(result, dependency.attemptId, dependency.attemptSnapshot)]
  })
}

/** 用依赖快照重建被续跑替代的 attempt，保证旧 scope 不会拿到新结果。 */
export function asInterruptedDelegationAttempt(
  result: DelegationResultLike,
  expectedAttemptId: string,
  attemptSnapshot?: AgentCollaborationAttemptSnapshot,
): DelegationResultLike {
  return {
    delegationId: result.delegationId,
    attemptId: expectedAttemptId,
    parentSessionId: attemptSnapshot?.parentSessionId ?? result.parentSessionId,
    childSessionId: attemptSnapshot?.childSessionId ?? result.childSessionId,
    channelId: attemptSnapshot?.channelId ?? result.channelId,
    modelId: attemptSnapshot?.modelId ?? result.modelId,
    thinkingLevel: attemptSnapshot?.thinkingLevel ?? result.thinkingLevel,
    thinkingLevelSemantics: attemptSnapshot?.thinkingLevelSemantics ?? result.thinkingLevelSemantics,
    title: attemptSnapshot?.title ?? result.title,
    role: attemptSnapshot?.role ?? result.role,
    goal: attemptSnapshot?.goal ?? result.goal,
    startedAt: attemptSnapshot?.startedAt ?? result.startedAt,
    status: 'interrupted',
    error: '当前协作 scope 引用的 attempt 已被续跑替代。',
    pendingBlockedEvents: [],
  }
}

function toMetadataView(
  result: DelegationResultLike,
  blockerBudget: BlockerBudget,
): Record<string, unknown> {
  const {
    resultSummary,
    goal,
    error,
    pendingBlockedEvents,
    ...identity
  } = result
  const blockerProjection = projectPendingBlockedEvents(pendingBlockedEvents, blockerBudget)
  return {
    ...identity,
    goal: truncatePreview(goal, GOAL_PREVIEW_CHAR_LIMIT),
    error: truncatePreview(error, ERROR_PREVIEW_CHAR_LIMIT),
    resultAvailable: resultSummary !== undefined,
    resultSummaryChars: resultSummary?.length ?? 0,
    ...(blockerProjection.items ? { pendingBlockedEvents: blockerProjection.items } : {}),
    ...(blockerProjection.truncated ? { pendingBlockedEventsTruncated: true } : {}),
  }
}

function projectPendingBlockedEvents(
  events: unknown,
  budget: BlockerBudget,
): { items?: Array<Record<string, unknown>>; truncated: boolean } {
  if (!Array.isArray(events) || events.length === 0) return { truncated: false }
  let truncated = events.length > budget.remainingEvents
  const items: Array<Record<string, unknown>> = []
  for (const event of events) {
    if (budget.remainingEvents <= 0) {
      truncated = true
      break
    }
    budget.remainingEvents -= 1
    const source = asRecord(event)
    if (!source) {
      truncated = true
      continue
    }
    const value: Record<string, unknown> = {
      id: asString(source.id),
      type: asString(source.type),
      askUserRequestId: asString(source.askUserRequestId),
    }
    const sourceQuestions = Array.isArray(source.askUserQuestions) ? source.askUserQuestions : []
    if (sourceQuestions.length > budget.remainingQuestions) truncated = true
    const questions: Array<Record<string, unknown>> = []
    for (const question of sourceQuestions) {
      if (budget.remainingQuestions <= 0) {
        truncated = true
        break
      }
      budget.remainingQuestions -= 1
      const questionRecord = asRecord(question)
      if (!questionRecord) {
        truncated = true
        continue
      }
      const questionView: Record<string, unknown> = {}
      const questionText = projectBlockerText(questionRecord.question, budget, () => {
        truncated = true
      })
      const header = projectBlockerText(questionRecord.header, budget, () => {
        truncated = true
      })
      if (questionText !== undefined) questionView.question = questionText
      if (header !== undefined) questionView.header = header
      const sourceOptions = Array.isArray(questionRecord.options) ? questionRecord.options : []
      if (sourceOptions.length > budget.remainingOptions) truncated = true
      const options: Array<Record<string, unknown>> = []
      for (const option of sourceOptions) {
        if (budget.remainingOptions <= 0) {
          truncated = true
          break
        }
        budget.remainingOptions -= 1
        const optionRecord = asRecord(option)
        if (!optionRecord) {
          truncated = true
          continue
        }
        const optionView: Record<string, unknown> = {}
        const label = projectBlockerText(optionRecord.label, budget, () => {
          truncated = true
        })
        const description = projectBlockerText(optionRecord.description, budget, () => {
          truncated = true
        })
        if (label !== undefined) optionView.label = label
        if (description !== undefined) optionView.description = description
        if (Object.keys(optionView).length > 0) options.push(optionView)
      }
      if (options.length > 0) questionView.options = options
      if (Object.keys(questionView).length > 0) questions.push(questionView)
    }
    if (questions.length > 0) value.askUserQuestions = questions
    if (Object.keys(value).length > 0) items.push(value)
  }
  return { items: items.length > 0 ? items : undefined, truncated }
}

function projectBlockerText(
  value: unknown,
  budget: BlockerBudget,
  onTruncated: () => void,
): string | undefined {
  if (typeof value !== 'string') return undefined
  if (budget.remainingChars <= 0) {
    onTruncated()
    return undefined
  }
  if (value.length <= budget.remainingChars) {
    budget.remainingChars -= value.length
    return value
  }
  onTruncated()
  const projected = value.slice(0, budget.remainingChars)
  budget.remainingChars = 0
  return projected
}

/**
 * 公平分配正文预算：短结果先拿满，剩余预算在长结果之间均分，
 * 最小单位 1 字符，保证多条结果都有可见预览。
 */
function allocatePreviewChars(lengths: readonly number[], budget: number): number[] {
  const allocations = lengths.map(() => 0)
  const remaining = lengths
    .map((length, index) => ({ index, length }))
    .filter((item) => item.length > 0)
    .sort((left, right) => left.length - right.length || left.index - right.index)
  let remainingBudget = budget
  let cursor = 0
  while (cursor < remaining.length && remainingBudget > 0) {
    const active = remaining.length - cursor
    const fairShare = Math.floor(remainingBudget / active)
    if (fairShare === 0) {
      for (let index = cursor; index < remaining.length && remainingBudget > 0; index += 1) {
        const item = remaining[index]
        if (!item) continue
        allocations[item.index] = 1
        remainingBudget -= 1
      }
      break
    }
    const item = remaining[cursor]
    if (!item) break
    if (item.length <= fairShare) {
      allocations[item.index] = item.length
      remainingBudget -= item.length
      cursor += 1
      continue
    }
    for (let index = cursor; index < remaining.length; index += 1) {
      const activeItem = remaining[index]
      if (activeItem) allocations[activeItem.index] = fairShare
    }
    remainingBudget -= fairShare * active
    for (let index = cursor; index < remaining.length && remainingBudget > 0; index += 1) {
      const activeItem = remaining[index]
      if (!activeItem) continue
      allocations[activeItem.index] = (allocations[activeItem.index] ?? 0) + 1
      remainingBudget -= 1
    }
    break
  }
  return allocations
}

function truncatePreview(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

function compareDelegationNewestFirst(
  left: DelegationResultLike,
  right: DelegationResultLike,
): number {
  return right.startedAt - left.startedAt || left.delegationId.localeCompare(right.delegationId)
}

function formatDelegationHistoryCursor(result: DelegationResultLike): string {
  return `${result.startedAt}:${encodeURIComponent(result.delegationId)}`
}

function parseDelegationHistoryCursor(cursor?: string): { startedAt: number; delegationId: string } | undefined {
  if (cursor === undefined) return undefined
  const separator = cursor.indexOf(':')
  if (separator <= 0) throw new Error('history cursor 无效')
  const startedAt = Number(cursor.slice(0, separator))
  if (!Number.isSafeInteger(startedAt)) throw new Error('history cursor 无效')
  try {
    const delegationId = decodeURIComponent(cursor.slice(separator + 1))
    if (!delegationId) throw new Error('empty delegation ID')
    return { startedAt, delegationId }
  } catch {
    throw new Error('history cursor 无效')
  }
}

function isAfterHistoryCursor(
  result: DelegationResultLike,
  cursor: { startedAt: number; delegationId: string },
): boolean {
  return result.startedAt < cursor.startedAt
    || (result.startedAt === cursor.startedAt
      && result.delegationId.localeCompare(cursor.delegationId) > 0)
}

function parseDelegationOffset(cursor?: string): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) throw new Error('cursor 必须是非负整数')
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new Error('cursor 超出安全整数范围')
  return offset
}
