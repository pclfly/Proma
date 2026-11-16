/**
 * Agent 内置协作会话工具
 *
 * 通过 Pi custom tools 暴露 Proma Agent 子会话委派能力。
 * Skill 负责判断何时协作；这里负责受控创建真实 Agent 会话、运行、等待和停止。
 */

import { budgetDelegationResults, type DelegationResultBudgetOptions } from './agent-collaboration-result-budget'
import {
  DEFAULT_COLLABORATION_RESULT_CHARS,
  MAX_COLLABORATION_RESULT_CHARS,
  paginateDelegationResults,
  projectDelegationResults,
  selectDelegationResults,
  validateDelegationResultReadOptions,
  type DelegationResultLike,
} from './agent-collaboration-result-view'
import { CollaborationCoordinator } from './agent-collaboration-coordinator'
import { randomUUID } from 'node:crypto'
import { classifyDelegationCompletion, getActiveAgentRun, getAssistantSummary, getFinalAssistantUuid, onAgentRunLifecycle, type AgentRunIdentity } from './agent-collaboration-lifecycle'
import { normalizeDelegationWaitSeconds } from '@proma/shared'
import type {
  AgentCollaborationAttemptSnapshot,
  AgentDelegationRole,
  AgentDelegationStatus,
  AgentSessionMeta,
  AgentStreamPayload,
  AgentThinkingLevel,
  AskUserRequest,
  PermissionRequest,
  PromaPermissionMode,
} from '@proma/shared'
import {
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  listAgentSessions,
  updateAgentSessionMeta,
} from './agent-session-manager'
import {
  runRegisteredHeadlessAgent,
  stopRegisteredAgent,
} from './agent-headless-runner-registry'
import {
  MAX_RUNNING_DELEGATIONS_PER_PARENT,
  buildRecoveredDelegationState,
  buildDelegationTaskWithSharedContext,
  buildDelegationPrompt,
  createToolCallIdempotencyCache,
  resolveDelegationPermissionMode,
  resolveDelegationWaitStatus,
} from './agent-collaboration-utils'
import { assertEnabledModelForChannel, listEnabledAgentModelsForChannel } from './agent-model-selection'
import { serializePiToolResultPayload } from './adapters/pi-tool-result-json'

interface CollaborationToolContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  permissionMode?: PromaPermissionMode
  triggeredBy?: 'user' | 'automation' | 'delegation'
}

interface CollaborationToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
}

interface DelegationRecord {
  delegationId: string
  attemptId: string
  parentSessionId: string
  childSessionId: string
  channelId: string
  modelId?: string
  title: string
  thinkingLevel?: AgentThinkingLevel
  role: AgentDelegationRole
  goal: string
  permissionMode: PromaPermissionMode
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
  error?: string
  resultSummary?: string
  runGeneration?: number
  resultUuid?: string
  invocationToken?: string
  completion: Promise<void>
  resolveCompletion: () => void
}


const DELEGATION_GOAL_CHAR_LIMIT = 1_000
/** live Map 中保留的已结束委派上限，超出时按完成时间清理最老的（持久化仍可回查） */
const MAX_RETAINED_FINISHED_DELEGATIONS = 200

const delegations = new Map<string, DelegationRecord>()
const stateListeners = new Set<() => void>()
let lifecycleRegistered = false

function notifyStateChanged(): void {
  for (const listener of stateListeners) listener()
}

function persistDelegation(record: DelegationRecord): void {
  updateAgentSessionMeta(record.childSessionId, {
    delegationStatus: record.status,
    delegationAttemptId: record.attemptId,
    delegationRunGeneration: record.runGeneration,
    delegationStartedAt: record.startedAt,
    delegationCompletedAt: record.completedAt,
    delegationError: record.error,
    delegationResultUuid: record.resultUuid,
  })
}

function beginDelegationRun(record: DelegationRecord, identity: AgentRunIdentity, recovering = false): void {
  if (!recovering && record.runGeneration !== undefined && record.runGeneration >= identity.runGeneration) return
  record.resolveCompletion()
  Object.assign(record, createDelegationCompletion(), {
    status: 'running', startedAt: identity.startedAt, runGeneration: identity.runGeneration,
    error: undefined, resultSummary: undefined, resultUuid: '', completedAt: undefined,
    invocationToken: undefined,
  })
  for (const blocked of blockedEvents.values()) {
    if (blocked.delegationId === record.delegationId) blocked.resolved = true
  }
  persistDelegation(record)
  notifyStateChanged()
}

/** 同步注册，桌面和 headless 的已接受运行使用唯一状态源（不依赖 UI EventBus）。 */
export function registerCollaborationLifecycle(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  onAgentRunLifecycle(({ sessionId, identity, completion }) => {
    const meta = getAgentSessionMeta(sessionId)
    if (!meta?.sourceDelegationId) return
    let record = delegations.get(meta.sourceDelegationId)
    if (record && record.childSessionId !== sessionId) return
    if (!record) {
      if (!meta.parentSessionId) return
      record = recoverDelegationRecordFromSession(meta.parentSessionId, meta.sourceDelegationId, meta, meta.permissionMode, meta.channelId ?? '', meta.modelId)
    }
    if (!completion) {
      beginDelegationRun(record, identity)
      return
    }
    if (record.runGeneration !== identity.runGeneration) return
    record.resultUuid = completion.finalAssistantUuid ?? ''
    markDelegationFinished(record, classifyDelegationCompletion(completion), {
      error: completion.error ?? completion.resultErrors?.join('\n') ?? (completion.resultSubtype?.startsWith('error') ? completion.resultSubtype : undefined),
    })
  })
}
// Pi 的 provider/retry 流可能重放同一个 tool call；委派会创建真实会话，必须幂等。
const piDelegateAgentCalls = createToolCallIdempotencyCache<PiDelegationToolResult>()
const piDelegateAgentsCalls = createToolCallIdempotencyCache<PiBatchDelegationResult>()
interface ContinuationReceipt {
  delegationId: string
  continuationId: string
  requestedAt: number
}
const piContinueCalls = createToolCallIdempotencyCache<ContinuationReceipt>()

// ===== 阻塞事件追踪（Level 1: Blocked Event Bubbling） =====

interface BlockedEvent {
  id: string
  delegationId: string
  childSessionId: string
  type: 'ask_user' | 'permission'
  askUserRequestId?: string
  askUserQuestions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }> }>
  permissionRequestId?: string
  permissionToolName?: string
  resolved: boolean
  createdAt: number
}

const blockedEvents = new Map<string, BlockedEvent>()

let _eventBusRegistered = false
let _eventBusRef: import('./agent-event-bus').AgentEventBus | null = null

export function registerCollaborationEventBus(eventBus: import('./agent-event-bus').AgentEventBus): void {
  if (_eventBusRegistered) return
  _eventBusRegistered = true
  _eventBusRef = eventBus

  eventBus.on((sessionId: string, payload: AgentStreamPayload) => {
    const record = Array.from(delegations.values()).find((d) => d.childSessionId === sessionId)
    if (!record || record.status !== 'running') return
    if (payload.kind !== 'proma_event') return

    const event = payload.event
    if (event.type === 'ask_user_request') {
      const req = event.request as AskUserRequest
      const blocked: BlockedEvent = {
        id: randomUUID(),
        delegationId: record.delegationId,
        childSessionId: sessionId,
        type: 'ask_user',
        askUserRequestId: req.requestId,
        askUserQuestions: req.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        })),
        resolved: false,
        createdAt: Date.now(),
      }
      blockedEvents.set(blocked.id, blocked)

      eventBus.emit(record.parentSessionId, {
        kind: 'proma_event',
        event: {
          type: 'delegation_blocked' as const,
          delegationId: record.delegationId,
          blockedEvent: blocked,
        } as import('@proma/shared').PromaEvent,
      })
    }

    if (event.type === 'permission_request') {
      const req = event.request as PermissionRequest
      const blocked: BlockedEvent = {
        id: randomUUID(),
        delegationId: record.delegationId,
        childSessionId: sessionId,
        type: 'permission',
        permissionRequestId: req.requestId,
        permissionToolName: req.toolName,
        resolved: false,
        createdAt: Date.now(),
      }
      blockedEvents.set(blocked.id, blocked)

      eventBus.emit(record.parentSessionId, {
        kind: 'proma_event',
        event: {
          type: 'delegation_blocked' as const,
          delegationId: record.delegationId,
          blockedEvent: blocked,
        } as import('@proma/shared').PromaEvent,
      })
    }

    if (event.type === 'ask_user_resolved' || event.type === 'permission_resolved') {
      const requestId = 'requestId' in event ? (event as { requestId: string }).requestId : undefined
      if (requestId) {
        for (const be of blockedEvents.values()) {
          if (be.resolved) continue
          if (be.askUserRequestId === requestId || be.permissionRequestId === requestId) {
            be.resolved = true
            break
          }
        }
      }
    }
  })

  console.log('[协作工具] EventBus 阻塞事件监听已注册')
}

function getPendingBlockedEvents(delegationId: string): BlockedEvent[] {
  return Array.from(blockedEvents.values()).filter((be) => be.delegationId === delegationId && !be.resolved)
}

function getBlockedEventById(blockedEventId: string): BlockedEvent | undefined {
  return blockedEvents.get(blockedEventId)
}

/**
 * 清理内存中过多的已结束委派，避免 live Map 无界增长。
 * 仅清理 status !== 'running' 的记录；被清理项仍可通过持久化会话回查。
 */
function pruneFinishedDelegations(): void {
  const finished = Array.from(delegations.values()).filter((item) => item.status !== 'running')
  const excess = finished.length - MAX_RETAINED_FINISHED_DELEGATIONS
  if (excess <= 0) return
  finished
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    .slice(0, excess)
    .forEach((item) => delegations.delete(item.delegationId))
}


function normalizeTitle(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim()
  if (trimmed) return trimmed.slice(0, 80)
  return fallback.slice(0, 80)
}

function truncateText(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[内容过长，已截断 ${text.length - limit} 字符]`
}

function assertNonBlank(value: string | undefined, field: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`${field} 不能为空`)
  }
  return trimmed
}

interface DelegateAgentArgs {
  title?: string
  role?: AgentDelegationRole
  task: string
  expectedOutput?: string
  permissionMode?: PromaPermissionMode
  modelId?: string | null
  /** 子会话的目标思考强度；未传入时保持新会话默认值。 */
  thinkingLevel?: AgentThinkingLevel
}

interface StartDelegationResult {
  record: DelegationRecord
  effectivePermissionMode: PromaPermissionMode
  effectiveModelId?: string
  configuredThinkingLevel: AgentThinkingLevel
}

interface PiDelegationToolResult {
  delegationId: string
  effectivePermissionMode: PromaPermissionMode
  effectiveModelId?: string
  configuredThinkingLevel: AgentThinkingLevel
}

interface PiBatchDelegationResult {
  created: PiDelegationToolResult[]
  failures: Array<{ index: number; title?: string; error: string }>
}

const VALID_THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function assertThinkingLevel(value: AgentThinkingLevel | undefined): AgentThinkingLevel | undefined {
  if (value === undefined) return undefined
  if (!VALID_THINKING_LEVELS.includes(value)) {
    throw new Error(`无效的子会话思考强度: ${String(value)}`)
  }
  return value
}

const THINKING_LEVEL_SEMANTICS = 'configured/requested'

function getThinkingLevelSummary(level: AgentThinkingLevel | undefined): Record<string, unknown> {
  return {
    thinkingLevel: level,
    thinkingLevelSemantics: THINKING_LEVEL_SEMANTICS,
  }
}

function getRunningDelegationCount(parentSessionId: string): number {
  return Array.from(delegations.values())
    .filter((item) => item.parentSessionId === parentSessionId && item.status === 'running')
    .length
}

function createDelegationCompletion(): Pick<DelegationRecord, 'completion' | 'resolveCompletion'> {
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  return { completion, resolveCompletion }
}

function assertCanCreateDelegation(
  ctx: CollaborationToolContext,
  requestedCount = 1,
): AgentSessionMeta | undefined {
  const parent = getAgentSessionMeta(ctx.sessionId)
  const delegationDepth = parent?.delegationDepth ?? 0

  if (ctx.triggeredBy === 'delegation' || delegationDepth > 0) {
    throw new Error('协作子会话不能继续创建新的子会话')
  }

  const runningCount = getRunningDelegationCount(ctx.sessionId)
  if (runningCount + requestedCount > MAX_RUNNING_DELEGATIONS_PER_PARENT) {
    throw new Error(`当前父会话已有 ${runningCount} 个运行中的协作子会话，最多允许 ${MAX_RUNNING_DELEGATIONS_PER_PARENT} 个`)
  }

  if (!ctx.channelId) {
    throw new Error('创建协作子会话需要可用的 channelId')
  }
  if (!ctx.workspaceId) {
    throw new Error('创建协作子会话需要绑定项目')
  }

  return parent
}

function summarizeChildResult(record: DelegationRecord): string {
  if (record.resultSummary !== undefined) return record.resultSummary
  if (record.resultUuid === '') return '本轮未产生可摘要的 assistant 正文。请打开子会话查看完整记录。'
  const messages = getAgentSessionSDKMessages(record.childSessionId)
  // 旧版本无结果引用时只取最后一条正文；新轮显式空引用绝不能借用旧结果。
  const uuid = record.resultUuid ?? [...messages].reverse().map(getFinalAssistantUuid).find(Boolean)
  return getAssistantSummary(messages, uuid) ?? '本轮未产生可摘要的 assistant 正文。请打开子会话查看完整记录。'
}

function markDelegationFinished(
  record: DelegationRecord,
  status: AgentDelegationStatus,
  fields: { error?: string; resultSummary?: string } = {},
): void {
  if (record.status !== 'running') return
  record.status = status
  record.completedAt = Date.now()
  record.error = fields.error
  record.resultSummary = fields.resultSummary
  persistDelegation(record)
  record.resolveCompletion()
  notifyStateChanged()
}

function getDelegationSummary(record: DelegationRecord, includeResult = true): Record<string, unknown> {
  return {
    delegationId: record.delegationId,
    attemptId: record.attemptId,
    parentSessionId: record.parentSessionId,
    childSessionId: record.childSessionId,
    channelId: record.channelId,
    modelId: record.modelId,
    ...getThinkingLevelSummary(getAgentSessionMeta(record.childSessionId)?.reasoningLevel ?? record.thinkingLevel),
    title: record.title,
    role: record.role,
    goal: record.goal,
    permissionMode: record.permissionMode,
    status: record.status,
    runGeneration: record.runGeneration,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    error: record.error,
    resultSummary: !includeResult || record.status === 'running' ? undefined : summarizeChildResult(record),
    pendingBlockedEvents: getPendingBlockedEvents(record.delegationId),
  }
}

function toAttemptSnapshot(summary: Record<string, unknown>): AgentCollaborationAttemptSnapshot {
  const text = (key: string): string | undefined => {
    const value = summary[key]
    return typeof value === 'string' ? value : undefined
  }
  return {
    parentSessionId: text('parentSessionId'),
    childSessionId: text('childSessionId'),
    channelId: text('channelId'),
    modelId: text('modelId'),
    thinkingLevel: text('thinkingLevel') as AgentCollaborationAttemptSnapshot['thinkingLevel'],
    thinkingLevelSemantics: text('thinkingLevelSemantics'),
    title: text('title'),
    role: text('role') as AgentCollaborationAttemptSnapshot['role'],
    goal: text('goal'),
    startedAt: typeof summary.startedAt === 'number' ? summary.startedAt : undefined,
  }
}

function listKnownDelegations(
  parentSessionId: string,
  includeResult = false,
): Array<Record<string, unknown>> {
  const ids = new Set(Array.from(delegations.values()).filter((item) => item.parentSessionId === parentSessionId).map((item) => item.delegationId))
  for (const session of listAgentSessions()) {
    if (session.parentSessionId === parentSessionId && session.sourceDelegationId) ids.add(session.sourceDelegationId)
  }
  return [...ids].map((id) => {
    const record = getDelegationRecordForContinuation({ sessionId: parentSessionId, channelId: '' }, id)!
    return getDelegationSummary(record, includeResult)
  })
}

function getDelegationResult(parentSessionId: string, delegationId: string): Record<string, unknown> {
  const record = getDelegationRecordForContinuation({ sessionId: parentSessionId, channelId: '' }, delegationId)
  if (!record) throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  return getDelegationSummary(record)
}

function setDelegationThinkingLevel(
  parentSessionId: string,
  delegationId: string,
  requestedLevel: AgentThinkingLevel,
): Record<string, unknown> {
  const thinkingLevel = assertThinkingLevel(requestedLevel)!
  const session = getPersistedDelegationSession(parentSessionId, delegationId, { allowMissingParentId: false })
  if (!session) {
    throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  }

  const updated = updateAgentSessionMeta(session.id, { reasoningLevel: thinkingLevel })
  const live = delegations.get(delegationId)
  if (live) live.thinkingLevel = thinkingLevel

  return {
    delegationId,
    childSessionId: session.id,
    modelId: session.modelId,
    status: live?.status ?? session.delegationStatus,
    ...getThinkingLevelSummary(updated.reasoningLevel),
    effectiveTiming: 'next_turn',
    note: live?.status === 'running'
      ? '子会话当前 turn 已按启动时的思考强度运行；新强度从下一轮或续跑开始生效。'
      : '新强度将在该子会话下一次续跑时生效。',
  }
}

function findPersistedDelegationSessions(delegationId: string): AgentSessionMeta[] {
  return listAgentSessions()
    .filter((item) => item.sourceDelegationId === delegationId)
}

function getPersistedDelegationSession(
  parentSessionId: string,
  delegationId: string,
  options: { allowMissingParentId?: boolean } = {},
): AgentSessionMeta | undefined {
  const sessions = findPersistedDelegationSessions(delegationId)
  const scoped = sessions.find((item) => item.parentSessionId === parentSessionId)
  if (scoped) return scoped

  // 应用重启、恢复或旧数据修复后，父会话上下文可能暂时不完整。
  // delegationId 本身是 UUID；当全局只有唯一命中时，允许用它恢复，避免误报“当前会话下未找到”。
  // 写操作必须显式关闭该兼容回退，严格要求持久化 parentSessionId 与当前父会话一致。
  if (options.allowMissingParentId === false || sessions.length !== 1) return undefined
  const unique = sessions[0]
  if (!unique) return undefined
  if (unique.parentSessionId == null || unique.parentSessionId === parentSessionId) {
    return unique
  }
  return undefined
}

function recoverDelegationRecordFromSession(
  parentSessionId: string,
  delegationId: string,
  session: AgentSessionMeta,
  fallbackPermissionMode: PromaPermissionMode | undefined,
  fallbackChannelId: string,
  fallbackModelId: string | undefined,
): DelegationRecord {
  const state = buildRecoveredDelegationState({
    // 与 getDelegationResult 保持一致：优先信任持久化记录里的父会话归属，
    // 仅在缺失时回落到当前会话上下文，避免两条恢复路径对 owner 判断不一致。
    parentSessionId: session.parentSessionId ?? parentSessionId,
    delegationId,
    session,
    fallbackPermissionMode,
  })
  const completionHandle = createDelegationCompletion()
  const record: DelegationRecord = {
    ...state,
    attemptId: session.delegationAttemptId ?? `legacy:${delegationId}:${session.updatedAt}`,
    channelId: session.channelId ?? fallbackChannelId,
    modelId: session.modelId ?? fallbackModelId,
    thinkingLevel: session.reasoningLevel,
    runGeneration: session.delegationRunGeneration,
    resultUuid: session.delegationResultUuid,
    error: session.delegationError,
    ...completionHandle,
  }
  delegations.set(delegationId, record)
  const active = getActiveAgentRun(session.id)
  if (active) beginDelegationRun(record, active, true)
  else record.resolveCompletion()
  return record
}

function getDelegationRecordForContinuation(
  ctx: CollaborationToolContext,
  delegationId: string,
): DelegationRecord | undefined {
  const live = delegations.get(delegationId)
  if (live) {
    if (live.parentSessionId !== ctx.sessionId) {
      throw new Error(`委派不属于当前父会话: ${delegationId}`)
    }
    return live
  }

  const session = getPersistedDelegationSession(ctx.sessionId, delegationId)
  if (!session) return undefined
  return recoverDelegationRecordFromSession(ctx.sessionId, delegationId, session, ctx.permissionMode, ctx.channelId, ctx.modelId)
}

function resolveWaitTargets(ids: string[], parentSessionId: string): DelegationRecord[] {
  return [...new Set(ids)].map((id) => {
    const record = getDelegationRecordForContinuation({ sessionId: parentSessionId, channelId: '' }, id)
    if (!record) throw new Error(`未找到当前会话下的委派: ${id}`)
    return record
  })
}

function throwIfWaitAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('协作等待已取消；子会话不会因此自动停止。', 'AbortError')
}

async function waitForLiveRecords(parentSessionId: string, ids: string[], timeoutSeconds: number, target: number, signal?: AbortSignal): Promise<void> {
  throwIfWaitAborted(signal)
  const deadline = Date.now() + normalizeDelegationWaitSeconds(timeoutSeconds) * 1000
  while (resolveWaitTargets(ids, parentSessionId).filter((record) => record.status !== 'running').length < target) {
    throwIfWaitAborted(signal)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    let check: (() => void) | undefined
    try {
      await new Promise<void>((resolve) => {
        check = () => { resolve() }
        // 取消仅唤醒并释放父等待，不能自动停止已接受的子任务。
        stateListeners.add(check)
        signal?.addEventListener('abort', check, { once: true })
        timeout = setTimeout(resolve, remaining)
        if (signal?.aborted) resolve()
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      if (check) {
        stateListeners.delete(check)
        signal?.removeEventListener('abort', check)
      }
    }
    throwIfWaitAborted(signal)
  }
}

function getCurrentParentPermissionMode(
  parent: AgentSessionMeta | undefined,
  fallback: PromaPermissionMode | undefined,
): PromaPermissionMode | undefined {
  const latestParent = parent ? getAgentSessionMeta(parent.id) : undefined
  return latestParent?.permissionMode ?? parent?.permissionMode ?? fallback
}

function getAvailableAgentModels(ctx: CollaborationToolContext): Record<string, unknown> {
  const currentModelId = ctx.modelId?.trim() || undefined
  const summary = listEnabledAgentModelsForChannel(ctx.channelId, '读取协作子会话可用模型')
  return {
    channelId: summary.channelId,
    channelName: summary.channelName,
    provider: summary.provider,
    currentModelId,
    currentModelAvailable: currentModelId
      ? summary.models.some((model) => model.id === currentModelId)
      : false,
    models: summary.models.map((model) => ({
      ...model,
      current: model.id === currentModelId,
    })),
    modelCount: summary.models.length,
    note: summary.models.length > 0
      ? '创建协作子会话时，可从 models[].id 中选择 modelId；不传则继承 currentModelId。'
      : '当前渠道没有启用的 Agent 模型，请先在渠道设置中启用模型。',
  }
}

function stopDelegation(parentSessionId: string, delegationId: string): Record<string, unknown> {
  const record = delegations.get(delegationId)
  if (!record) {
    // 不在内存：可能是应用重启后的遗留委派。回退到持久化记录（完全找不到才抛错），无法主动停止
    return {
      delegation: getDelegationResult(parentSessionId, delegationId),
      stopped: false,
      note: '该委派不在当前运行内存中（可能因应用重启已中断），无法主动停止。',
    }
  }
  if (record.parentSessionId !== parentSessionId) {
    throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  }
  if (record.status !== 'running') {
    return {
      delegation: getDelegationSummary(record),
      stopped: false,
    }
  }

  stopRegisteredAgent(record.childSessionId)
  markDelegationFinished(record, 'cancelled')
  return {
    delegation: getDelegationSummary(record),
    stopped: true,
  }
}

function runDelegation(record: DelegationRecord, message: string, workspaceId?: string): void {
  const token = randomUUID()
  record.invocationToken = token
  const failBeforeAccepted = (error: string): void => {
    // accepted 已清除此 token；旧 promise/callback 绝不能结束新轮。
    if (record.invocationToken !== token) return
    record.resultUuid = ''
    markDelegationFinished(record, 'failed', { error })
  }
  runRegisteredHeadlessAgent({
    sessionId: record.childSessionId, userMessage: message,
    channelId: record.channelId, modelId: record.modelId, workspaceId,
    permissionModeOverride: record.permissionMode, triggeredBy: 'delegation', startedAt: record.startedAt,
  }, {
    source: 'delegation', originSessionId: record.parentSessionId,
    onError: failBeforeAccepted,
    onComplete: () => { failBeforeAccepted('运行未被接受或未发布终态，请检查子会话。') },
    onTitleUpdated: (title) => { record.title = title },
  }).catch((error: unknown) => failBeforeAccepted(error instanceof Error ? error.message : '未知错误'))
}

function startDelegation(
  ctx: CollaborationToolContext,
  parent: AgentSessionMeta | undefined,
  args: DelegateAgentArgs,
  scope?: CollaborationCoordinator,
): StartDelegationResult {
  const task = assertNonBlank(args.task, 'task')
  scope?.assertCanStart()
  const delegationId = randomUUID()
  const attemptId = randomUUID()
  const role = args.role ?? 'custom'
  const title = normalizeTitle(args.title, `协作：${task}`)
  const goal = truncateText(task, DELEGATION_GOAL_CHAR_LIMIT)
  const parentPermissionMode = getCurrentParentPermissionMode(parent, ctx.permissionMode)
  const permissionMode = resolveDelegationPermissionMode(
    parentPermissionMode,
    args.permissionMode,
  )
  const thinkingLevel = assertThinkingLevel(args.thinkingLevel)
  const effectiveModelId = args.modelId != null
    ? assertEnabledModelForChannel({
        channelId: ctx.channelId,
        modelId: args.modelId,
        purpose: '创建协作子会话',
      })
    : ctx.modelId?.trim() || undefined

  const { completion, resolveCompletion } = createDelegationCompletion()

  const child = createAgentSession(title, ctx.channelId, ctx.workspaceId, effectiveModelId)
  const childThinkingLevel: AgentThinkingLevel = thinkingLevel ?? child.reasoningLevel ?? 'high'
  const rootSessionId = parent?.rootSessionId ?? parent?.id ?? ctx.sessionId
  updateAgentSessionMeta(child.id, {
    parentSessionId: ctx.sessionId,
    rootSessionId,
    sourceDelegationId: delegationId,
    sourceAutomationId: parent?.sourceAutomationId,
    delegationRole: role,
    delegationStatus: 'running',
    delegationAttemptId: attemptId,
    delegationDepth: (parent?.delegationDepth ?? 0) + 1,
    delegationGoal: goal,
    permissionMode,
    ...(thinkingLevel ? { reasoningLevel: thinkingLevel } : {}),
  })

  const record: DelegationRecord = {
    delegationId,
    attemptId,
    parentSessionId: ctx.sessionId,
    childSessionId: child.id,
    channelId: ctx.channelId,
    modelId: effectiveModelId,
    thinkingLevel: childThinkingLevel,
    title,
    role,
    goal,
    permissionMode,
    status: 'running',
    startedAt: Date.now(),
    completion,
    resolveCompletion,
  }
  delegations.set(delegationId, record)
  scope?.track(delegationId, attemptId, toAttemptSnapshot(getDelegationSummary(record, false)))
  pruneFinishedDelegations()

  const prompt = buildDelegationPrompt({
    parentSessionId: ctx.sessionId,
    delegationId,
    role,
    task,
    expectedOutput: args.expectedOutput,
  })

  runDelegation(record, prompt, ctx.workspaceId)

  return {
    record,
    effectivePermissionMode: permissionMode,
    effectiveModelId,
    configuredThinkingLevel: childThinkingLevel,
  }
}

export interface CollaborationBoundaryRequest {
  receipts: string[]
  timeoutSeconds: number
  checkOnly?: boolean
}

export interface CollaborationBoundaryDelivery {
  receipts: string[]
  text: string
}

export interface CollaborationBoundaryResult {
  pending: boolean
  reason?: string
  delivery?: CollaborationBoundaryDelivery
}

export type CollaborationBoundaryHandler = (
  request: CollaborationBoundaryRequest,
  signal: AbortSignal,
) => Promise<CollaborationBoundaryResult>

function delegationReceipt(summary: Record<string, unknown>): string | undefined {
  const delegationId = typeof summary.delegationId === 'string' ? summary.delegationId : undefined
  const status = typeof summary.status === 'string' ? summary.status : undefined
  if (!delegationId || !status || status === 'running') return undefined
  const generation = typeof summary.runGeneration === 'number' ? summary.runGeneration : 0
  return `${delegationId}:${generation}:${status}`
}

function pendingBlockedIds(summary: Record<string, unknown>): string[] {
  const pending = summary.pendingBlockedEvents
  if (!Array.isArray(pending)) return []
  return pending.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const id = (item as { blockedEventId?: unknown }).blockedEventId
    return typeof id === 'string' ? [id] : []
  })
}

interface CollaborationReceiptRef {
  delegationId: string
  attemptId: string
  status: string
  pendingBlockedEvents?: unknown[]
}

function collectCollaborationReceiptRefs(
  value: unknown,
  refs: CollaborationReceiptRef[] = [],
): CollaborationReceiptRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCollaborationReceiptRefs(item, refs)
    return refs
  }
  if (!value || typeof value !== 'object') return refs
  const record = value as Record<string, unknown>
  if (typeof record.delegationId === 'string' && typeof record.attemptId === 'string') {
    refs.push({
      delegationId: record.delegationId,
      attemptId: record.attemptId,
      status: typeof record.status === 'string' ? record.status : 'running',
      ...(Array.isArray(record.pendingBlockedEvents)
        ? { pendingBlockedEvents: record.pendingBlockedEvents }
        : {}),
    })
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'pendingBlockedEvents') continue
    collectCollaborationReceiptRefs(child, refs)
  }
  return refs
}

/**
 * 父会话 settle 前的协作收口。
 *
 * 官方 0.22.0 的 boundary 依赖 coordinator 的 receipts；本地协作栈使用
 * `listKnownDelegations` 的持久状态，因此这里生成等价的 `delegationId:generation:status`
 * 与 `delegationId:blocked:<id>` 凭据，保证同一条结果不会重复投递。
 */
export function createCollaborationBoundary(parentSessionId: string): CollaborationBoundaryHandler {
  return async (request, signal) => {
    const known = listKnownDelegations(parentSessionId)
    const running = known.filter((summary) => summary.status === 'running')
    const blocked = known.flatMap((summary) => pendingBlockedIds(summary))

    if (request.checkOnly) {
      return {
        pending: running.length > 0 || blocked.length > 0,
        reason: running.length > 0
          ? '仍有协作子会话在运行'
          : blocked.length > 0
            ? '协作子会话有未处理的阻塞事件'
            : undefined,
      }
    }

    if (running.length > 0) {
      const ids = running
        .map((summary) => (typeof summary.delegationId === 'string' ? summary.delegationId : undefined))
        .filter((id): id is string => !!id)
      await waitForLiveRecords(parentSessionId, ids, request.timeoutSeconds, ids.length, signal)
    }

    const after = listKnownDelegations(parentSessionId)
    const receipts = new Set(request.receipts)
    const freshIds = new Set<string>()
    for (const summary of after) {
      const delegationId = typeof summary.delegationId === 'string' ? summary.delegationId : undefined
      if (!delegationId) continue
      const receipt = delegationReceipt(summary)
      if (receipt && !receipts.has(receipt)) {
        receipts.add(receipt)
        freshIds.add(delegationId)
      }
      for (const blockedEventId of pendingBlockedIds(summary)) {
        const blockedReceipt = `${delegationId}:blocked:${blockedEventId}`
        if (!receipts.has(blockedReceipt)) {
          receipts.add(blockedReceipt)
          freshIds.add(delegationId)
        }
      }
    }

    const stillRunning = after.filter((summary) => summary.status === 'running')
    if (freshIds.size === 0) {
      return {
        pending: stillRunning.length > 0,
        reason: stillRunning.length > 0 ? '仍有协作子会话在运行' : undefined,
      }
    }

    const results = [...freshIds].map((delegationId) => getDelegationResult(parentSessionId, delegationId))
    return {
      pending: stillRunning.length > 0,
      delivery: {
        receipts: [...receipts],
        text: JSON.stringify({
          type: 'collaboration_results',
          results,
          note: '协作子会话结果已收敛；请基于结果继续父任务，不要重复等待同一批委派。',
        }, null, 2),
      },
    }
  }
}

// ===== Pi Runtime 桥接 =====

/**
 * 为 Pi runtime 构建协作会话工具定义。
 * 复用同一份内部状态（delegations Map、blocked events 等），
 * 只是用 Pi SDK 的 defineTool() + TypeBox schema 包装。
 */
export function buildPiCollaborationTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  ctx: CollaborationToolContext,
): { tools: unknown[]; boundary: CollaborationBoundaryHandler } {
  const { Type } = require('typebox') as typeof import('typebox')
  const scope = new CollaborationCoordinator(
    getAgentSessionMeta(ctx.sessionId)?.collaborationScope,
    (state) => {
      updateAgentSessionMeta(ctx.sessionId, { collaborationScope: structuredClone(state) })
    },
  )

  const roleType = Type.Optional(Type.Union([
    Type.Literal('explore'),
    Type.Literal('research'),
    Type.Literal('implement'),
    Type.Literal('review'),
    Type.Literal('custom'),
  ], { description: '子任务角色' }))

  const thinkingLevelType = Type.Optional(Type.Union([
    Type.Literal('off'),
    Type.Literal('minimal'),
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('xhigh'),
    Type.Literal('max'),
  ], { description: '子会话思考强度；未传则使用新会话默认值' }))

  const modelIdType = Type.Optional(Type.Union([
    Type.String({ minLength: 1, pattern: '\\S', description: '当前渠道已启用的精确模型ID；不能传空串' }),
    Type.Null(),
  ], { description: '可选目标模型ID；省略或null继承父模型。指定前先查询list_available_agent_models。' }))

  const delegateItemType = Type.Object({
    title: Type.Optional(Type.String({ description: '子会话标题' })),
    role: roleType,
    task: Type.String({ description: '发送给子 Agent 的完整任务说明' }),
    expectedOutput: Type.Optional(Type.String({ description: '希望子 Agent 最终返回的格式或要点' })),
    modelId: modelIdType,
    thinkingLevel: thinkingLevelType,
  })

  function piJsonResult(
    payload: object,
    budget?: DelegationResultBudgetOptions,
    skipBudget = false,
  ): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
    const withReceipts = {
      ...payload,
      collaborationReceipts: scope.receiptsFor(collectCollaborationReceiptRefs(payload)),
    }
    const value = skipBudget ? withReceipts : budgetDelegationResults(withReceipts, budget)
    const serialized = serializePiToolResultPayload(value)
    return {
      content: [{ type: 'text', text: serialized.text }],
      details: serialized.details,
    }
  }

  const tools = [
    sdk.defineTool({
      name: 'mcp__collaboration__list_available_agent_models',
      label: '列出可用模型',
      description: '列出当前父会话渠道下已启用、可用于协作子 Agent 的模型。需要给 delegate_agent/delegate_agents 指定 modelId 前应先调用此工具。',
      parameters: Type.Object({}),
      async execute() {
        return piJsonResult(getAvailableAgentModels(ctx))
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__delegate_agent',
      label: '委派子 Agent',
      description: '创建一个真实可见的 Proma 协作子 Agent 会话来并行处理独立子任务。可选 thinkingLevel 指定子会话首轮思考强度；模型不支持时运行时会安全归一化。返回中的 configuredThinkingLevel/thinkingLevel 表示配置/请求值，不代表模型 capability normalization 后的实际运行档位。委派只表示子会话已启动。',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: '子会话标题' })),
        role: roleType,
        task: Type.String({ description: '发送给子 Agent 的完整任务说明，必须自包含必要上下文' }),
        expectedOutput: Type.Optional(Type.String({ description: '希望子 Agent 最终返回的格式或要点' })),
        modelId: modelIdType,
        thinkingLevel: thinkingLevelType,
      }),
      async execute(toolCallId: string, params: unknown) {
        const args = params as DelegateAgentArgs
        const result = piDelegateAgentCalls.getOrCreate(ctx.sessionId, toolCallId, () => {
          const parent = assertCanCreateDelegation(ctx)
          const created = startDelegation(ctx, parent, args, scope)
          return {
            delegationId: created.record.delegationId,
            effectivePermissionMode: created.effectivePermissionMode,
            effectiveModelId: created.effectiveModelId,
            configuredThinkingLevel: created.configuredThinkingLevel,
          }
        })
        return piJsonResult({
          delegation: getDelegationResult(ctx.sessionId, result.delegationId),
          effectivePermissionMode: result.effectivePermissionMode,
          effectiveModelId: result.effectiveModelId,
          configuredThinkingLevel: result.configuredThinkingLevel,
          note: '子会话已启动，尚未完成或回传结果。记录 delegationId；如果本轮回复、决策或交付依赖它，必须在回复前调用 wait_for_delegations 收敛。仅在父会话还有完全独立的工作时才继续推进。',
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__delegate_agents',
      label: '批量委派子 Agent',
      description: '批量创建多个真实可见的 Proma 协作子 Agent 会话。每个 item 可独立指定首轮 thinkingLevel；模型不支持时运行时会安全归一化。返回中的 configuredThinkingLevels/delegations[].thinkingLevel 表示各项配置/请求值，不代表模型 capability normalization 后的实际运行档位。',
      parameters: Type.Object({
        sharedContext: Type.Optional(Type.String({ description: '批量子任务共用背景' })),
        items: Type.Array(delegateItemType, { description: '要创建的子会话列表，最多 50 个' }),
      }),
      async execute(toolCallId: string, params: unknown) {
        const args = params as { sharedContext?: string; items: DelegateAgentArgs[] }
        const batch = piDelegateAgentsCalls.getOrCreate(ctx.sessionId, toolCallId, () => {
          const parent = assertCanCreateDelegation(ctx, args.items.length)
          // thinkingLevel 是整批的结构性输入；必须先完整校验，避免后续非法项导致前置子会话已创建。
          args.items.forEach((item) => assertThinkingLevel(item.thinkingLevel))
          const created: PiDelegationToolResult[] = []
          const failures: Array<{ index: number; title?: string; error: string }> = []
          args.items.forEach((item, index) => {
            try {
              const started = startDelegation(ctx, parent, {
                ...item,
                task: buildDelegationTaskWithSharedContext({
                  sharedContext: args.sharedContext,
                  task: item.task,
                }),
              }, scope)
              created.push({
                delegationId: started.record.delegationId,
                effectivePermissionMode: started.effectivePermissionMode,
                effectiveModelId: started.effectiveModelId,
                configuredThinkingLevel: started.configuredThinkingLevel,
              })
            } catch (error) {
              failures.push({
                index,
                title: item.title,
                error: error instanceof Error ? error.message : '未知错误',
              })
            }
          })
          return { created, failures }
        })
        return piJsonResult({
          delegations: batch.created.map((item) => getDelegationResult(ctx.sessionId, item.delegationId)),
          effectivePermissionModes: batch.created.map((item) => ({
            delegationId: item.delegationId,
            permissionMode: item.effectivePermissionMode,
          })),
          effectiveModels: batch.created.map((item) => ({
            delegationId: item.delegationId,
            modelId: item.effectiveModelId,
          })),
          configuredThinkingLevels: batch.created.map((item) => ({
            delegationId: item.delegationId,
            thinkingLevel: item.configuredThinkingLevel,
          })),
          failures: batch.failures,
          createdCount: batch.created.length,
          failedCount: batch.failures.length,
          maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__wait_for_delegations',
      label: '等待子会话完成',
      description: '父会话用于收敛子会话结果的等待屏障：等待指定的 Proma 协作子会话完成，并返回结构化结果摘要。只要本轮回复、决策或交付依赖已委派任务，主会话必须在回复前调用本工具，不能只因 delegate_agent/delegate_agents 已返回就宣称完成；需要全部结果时传入所有 delegationIds 并使用 mode=all，需要部分早期结果时才使用 mode=any。若返回 timeout 或仍有 running 委派，必须如实说明未收敛状态，不能把未完成任务当作已有结果。',
      parameters: Type.Object({
        delegationIds: Type.Optional(Type.Array(Type.String(), { description: '要等待的委派 ID' })),
        mode: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('any')])),
        minCompleted: Type.Optional(Type.Number({ description: 'mode=any 时至少等待完成的数量，默认 1' })),
        timeoutSeconds: Type.Optional(Type.Number({ description: '最长等待秒数，默认 3600；最大 7200' })),
        maxResultChars: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_COLLABORATION_RESULT_CHARS, description: '总结果正文字符预算，默认12000' })),
        maxCharsPerResult: Type.Optional(Type.Number({ minimum: 0, maximum: 32000, description: '单项正文字符预算，默认4000' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        throwIfWaitAborted(signal)
        const args = params as { delegationIds?: string[]; mode?: 'all' | 'any'; minCompleted?: number; timeoutSeconds?: number; maxResultChars?: number; maxCharsPerResult?: number }
        const ids = args.delegationIds?.length
          ? args.delegationIds
          : Array.from(delegations.values())
            .filter((item) => item.parentSessionId === ctx.sessionId && item.status === 'running')
            .map((item) => item.delegationId)
        const liveRecords = resolveWaitTargets(ids, ctx.sessionId)
        const totalTargets = liveRecords.length
        if (totalTargets === 0) {
          return piJsonResult({ delegations: [], note: '没有找到可等待的协作委派' })
        }
        const mode = args.mode ?? 'all'
        const minCompleted = Number.isFinite(args.minCompleted) ? Math.floor(args.minCompleted!) : 1
        const timeoutSeconds = normalizeDelegationWaitSeconds(args.timeoutSeconds)
        const targetCompleted = mode === 'all' ? totalTargets : Math.max(1, Math.min(minCompleted, totalTargets))
        await waitForLiveRecords(ctx.sessionId, ids, timeoutSeconds, targetCompleted, signal)
        const allDelegations = resolveWaitTargets(ids, ctx.sessionId).map((record) => getDelegationSummary(record))
        const completedCount = allDelegations.filter((item) => item.status !== 'running').length
        const status = resolveDelegationWaitStatus({ finishedCount: completedCount, targetCompleted })
        const maxResultChars = args.maxResultChars ?? DEFAULT_COLLABORATION_RESULT_CHARS
        const payload = {
          status,
          mode,
          completedCount,
          runningCount: allDelegations.filter((item) => item.status === 'running').length,
          resultDetail: args.maxCharsPerResult === undefined ? 'preview' : undefined,
          maxResultChars,
          delegations: args.maxCharsPerResult === undefined
            ? projectDelegationResults(
                allDelegations as DelegationResultLike[],
                { detail: 'preview', maxResultChars },
              )
            : allDelegations,
          note: status === 'timeout'
            ? '等待未收敛：仍有委派在运行或未达到目标完成数，不能视为已完成。'
            : undefined,
        }
        if (args.maxCharsPerResult !== undefined) {
          return piJsonResult(payload, {
            totalChars: maxResultChars,
            perResultChars: args.maxCharsPerResult,
          })
        }
        return piJsonResult(payload, undefined, true)
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__list_delegations',
      label: '列出协作子会话',
      description: '列出协作子会话的紧凑状态，默认不返回结果正文。scope=current 仅查看当前协作 scope；scope=history 分页排查当前父会话的历史委派。需要某条结论时用 get_delegation_results 按 ID 精读。',
      parameters: Type.Object({
        scope: Type.Optional(Type.Union([
          Type.Literal('current'),
          Type.Literal('history'),
        ], { description: 'current 仅当前协作 scope；history 为当前父会话的持久化历史。默认 history 以兼容旧调用。' })),
        includeCompleted: Type.Optional(Type.Boolean({ description: '是否包含已完成委派，默认 true' })),
        includeResultPreview: Type.Optional(Type.Boolean({ description: '是否附带受总预算限制的结果预览，默认 false' })),
        maxResultChars: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_COLLABORATION_RESULT_CHARS, description: '结果预览合计最大字符数，默认 12000' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: '每页最多返回数量，默认 20' })),
        cursor: Type.Optional(Type.String({ description: '上一页返回的 nextCursor' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as {
          scope?: 'current' | 'history'
          includeCompleted?: boolean
          includeResultPreview?: boolean
          maxResultChars?: number
          limit?: number
          cursor?: string
        }
        const listScope = args.scope ?? 'history'
        const detail = args.includeResultPreview ? 'preview' : 'metadata'
        const maxResultChars = args.maxResultChars ?? DEFAULT_COLLABORATION_RESULT_CHARS
        const items = listKnownDelegations(
          ctx.sessionId,
          detail === 'preview',
        ) as DelegationResultLike[]
        const selected = selectDelegationResults({
          scope: listScope,
          dependencies: scope.snapshot.dependencies,
          all: items,
          includeCompleted: args.includeCompleted ?? true,
        })
        const page = paginateDelegationResults(selected, {
          cursor: args.cursor,
          limit: args.limit,
          order: listScope === 'history' ? 'newest-first' : 'input',
        })
        return piJsonResult({
          scope: listScope,
          scopeId: listScope === 'current' ? scope.snapshot.scopeId : undefined,
          totalCount: page.totalCount,
          nextCursor: page.nextCursor,
          maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
          runningCount: selected.filter((item) => item.status === 'running').length,
          resultDetail: detail,
          maxResultChars,
          delegations: projectDelegationResults(page.items, { detail, maxResultChars }),
        }, undefined, true)
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__get_delegation_results',
      label: '读取子会话结果',
      description: '按明确 delegation ID 读取结果。默认返回受总预算限制的 preview；detail=full 只允许读取一个 ID，适合精读被截断的结论。兼容旧调用：传 maxCharsPerResult 或 resultOffset 时使用按偏移分页的 resultRead。',
      parameters: Type.Object({
        delegationIds: Type.Array(Type.String(), { description: '要读取结果的委派 ID 列表' }),
        detail: Type.Optional(Type.Union([
          Type.Literal('preview'),
          Type.Literal('full'),
        ], { description: '结果读取粒度，默认 preview' })),
        maxResultChars: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_COLLABORATION_RESULT_CHARS, description: '本次结果正文合计最大字符数，默认 12000；full 最大 50000' })),
        maxCharsPerResult: Type.Optional(Type.Number({ minimum: 0, maximum: 32000, description: '兼容旧调用的单项正文预算；传入时使用 resultRead 分页' })),
        resultOffset: Type.Optional(Type.Number({ minimum: 0, description: '兼容旧调用的 UTF-16 字符偏移；分页时仅指定一个委派' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as {
          delegationIds: string[]
          detail?: 'preview' | 'full'
          maxResultChars?: number
          maxCharsPerResult?: number
          resultOffset?: number
        }
        const ids = [...new Set(args.delegationIds)]
        if (args.resultOffset && ids.length !== 1) throw new Error('分页精读时请仅指定一个 delegationId')
        if (args.maxCharsPerResult !== undefined || args.resultOffset !== undefined) {
          return piJsonResult({
            delegations: ids.map((delegationId) => getDelegationResult(ctx.sessionId, delegationId)),
          }, {
            totalChars: args.maxResultChars ?? 24_000,
            perResultChars: args.maxCharsPerResult ?? 12_000,
            offset: args.resultOffset,
          })
        }
        const options = validateDelegationResultReadOptions({
          delegationCount: ids.length,
          detail: args.detail,
          maxResultChars: args.maxResultChars,
        })
        return piJsonResult({
          detail: options.detail,
          maxResultChars: options.maxResultChars,
          delegations: projectDelegationResults(
            ids.map((delegationId) => getDelegationResult(ctx.sessionId, delegationId)) as DelegationResultLike[],
            options,
          ),
        }, undefined, true)
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__set_delegation_thinking_level',
      label: '设置子会话思考强度',
      description: '父 Agent 修改自己创建的协作子会话思考强度。当前已运行的 turn 不会中途切换，新强度从下一轮或续跑开始生效。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '要修改的委派 ID' }),
        thinkingLevel: Type.Union([
          Type.Literal('off'),
          Type.Literal('minimal'),
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high'),
          Type.Literal('xhigh'),
          Type.Literal('max'),
        ], { description: '新的子会话思考强度' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string; thinkingLevel: AgentThinkingLevel }
        return piJsonResult(setDelegationThinkingLevel(ctx.sessionId, args.delegationId, args.thinkingLevel))
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__stop_delegation',
      label: '停止子会话',
      description: '停止一个正在运行的 Proma 协作子会话。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '要停止的委派 ID' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string }
        return piJsonResult(stopDelegation(ctx.sessionId, args.delegationId))
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__stop_delegations',
      label: '批量停止子会话',
      description: '批量停止多个正在运行的 Proma 协作子会话。',
      parameters: Type.Object({
        delegationIds: Type.Array(Type.String(), { description: '要停止的委派 ID 列表' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationIds: string[] }
        return piJsonResult({
          results: args.delegationIds.map((delegationId) => stopDelegation(ctx.sessionId, delegationId)),
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__answer_delegation_question',
      label: '代答子会话问题',
      description: '代答协作子会话的阻塞问题或审批权限请求。从 delegation 的 pendingBlockedEvents 获取 blockedEventId。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '子会话所属的委派 ID' }),
        blockedEventId: Type.String({ description: '要回答的阻塞事件 ID' }),
        answers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'AskUserQuestion 的回答' })),
        permissionBehavior: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('deny')])),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string; blockedEventId: string; answers?: Record<string, string>; permissionBehavior?: 'allow' | 'deny' }
        const blocked = getBlockedEventById(args.blockedEventId)
        if (!blocked) throw new Error(`阻塞事件不存在: ${args.blockedEventId}`)
        if (blocked.resolved) return piJsonResult({ answered: false, note: '该阻塞事件已被解决' })

        const record = delegations.get(blocked.delegationId)
        if (record && record.parentSessionId !== ctx.sessionId) {
          throw new Error(`委派不属于当前父会话: ${blocked.delegationId}`)
        }

        if (blocked.type === 'ask_user' && blocked.askUserRequestId) {
          const { askUserService } = await import('./agent-ask-user-service')
          const answers = args.answers ?? {}
          const sessionId = askUserService.respondToAskUser(blocked.askUserRequestId, answers)
          blocked.resolved = !!sessionId
          if (blocked.resolved && _eventBusRef) {
            _eventBusRef.emit(blocked.childSessionId, {
              kind: 'proma_event',
              event: { type: 'ask_user_resolved', requestId: blocked.askUserRequestId },
            })
          }
          return piJsonResult({ answered: blocked.resolved, type: 'ask_user' })
        }

        if (blocked.type === 'permission' && blocked.permissionRequestId) {
          const { permissionService } = await import('./agent-permission-service')
          const behavior = args.permissionBehavior ?? 'allow'
          const sessionId = permissionService.respondToPermission(blocked.permissionRequestId, behavior, false)
          blocked.resolved = !!sessionId
          if (blocked.resolved && _eventBusRef) {
            _eventBusRef.emit(blocked.childSessionId, {
              kind: 'proma_event',
              event: { type: 'permission_resolved', requestId: blocked.permissionRequestId, behavior },
            })
          }
          return piJsonResult({ answered: blocked.resolved, type: 'permission', behavior })
        }

        return piJsonResult({ answered: false, note: '无法匹配阻塞事件类型' })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__continue_delegation',
      label: '追加后续指令',
      description: '向已完成、已失败、已取消或已中断的协作子会话追加指令。接受请求后立即返回，不等待子任务完成；必须用wait_for_delegations收敛结果。同一toolCallId重放不会重复续跑。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '要继续操作的委派 ID' }),
        message: Type.String({ description: '追加给子 Agent 的后续指令' }),
      }),
      async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
        throwIfWaitAborted(signal)
        const args = params as { delegationId: string; message: string }
        const receipt = piContinueCalls.getOrCreate(ctx.sessionId, toolCallId, () => {
          const message = assertNonBlank(args.message, 'message')
          const record = getDelegationRecordForContinuation(ctx, args.delegationId)
          if (!record) throw new Error(`未找到当前会话下的委派: ${args.delegationId}`)
          if (record.status === 'running') throw new Error(`委派正在运行中，无法追加指令: ${args.delegationId}`)
          scope.assertCanStart()
          const requestedAt = Date.now()
          const attemptId = randomUUID()
          Object.assign(record, createDelegationCompletion(), {
            status: 'running', error: undefined, resultSummary: undefined,
            resultUuid: '', completedAt: undefined, startedAt: requestedAt, attemptId,
          })
          persistDelegation(record)
          scope.track(
            record.delegationId,
            attemptId,
            toAttemptSnapshot(getDelegationSummary(record, false)),
          )
          notifyStateChanged()
          runDelegation(record, message, ctx.workspaceId)
          return { delegationId: record.delegationId, continuationId: randomUUID(), requestedAt }
        })
        return piJsonResult({
          accepted: true,
          continuation: receipt,
          delegation: getDelegationResult(ctx.sessionId, receipt.delegationId),
          note: '续跑请求已接受；这不是完成确认。请用wait_for_delegations收敛结果，不要因尚未完成而重复追加同一指令。',
        })
      },
    }),
  ]
  return { tools, boundary: createCollaborationBoundary(ctx.sessionId) }
}
