/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import type { WebContents } from 'electron'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  AgentDeferredQueueMessageInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
  AgentQueuedMessageControlInput,
  AgentMoveQueuedMessageInput,
  AgentPromoteQueuedMessageInput,
  AgentPromoteQueuedMessageResult,
  PromaPermissionMode,
  AgentExternalRunSource,
  AgentActiveSessionSnapshot,
  AgentQueuedMessageSnapshot,
  AgentMessage,
} from '@proma/shared'
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { PiUtilityAdapter } from './adapters/pi-utility-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'
import { notePlanQuotaUsage } from './plan-quota-signal'
import { getAgentSessionWorkspacePath } from './config-paths'
import { getAgentWorkspaceBySlug, getProjectFilesPath } from './agent-workspace-manager'
import { getLocalProjectRootStatus } from './project-root-health'
import { getAgentSessionMeta, isAgentSessionDeleting, markAgentSessionDeleting, updateAgentSessionMeta } from './agent-session-manager'
import { setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
import { getHeadlessAgentRunTarget } from './agent-headless-run-target'
import { sendAgentStreamComplete } from './agent-completion-payload'
import { AgentStreamForwarder } from './agent-stream-forwarder'
import { AgentStreamRouteRegistry } from './agent-stream-route-registry'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import { AgentRunDrainRegistry } from './agent-run-drain-registry'
import { AgentQueryDrainError } from './agent-query-drain'
import { configureWorkspaceKnowledgeAttribution } from './workspace-knowledge-mutation-runtime'
import type { AgentRunDrainRecord } from './agent-run-drain-registry'
import { isStaleActiveQueueError } from './agent-queue-routing'
import { registerCollaborationEventBus, registerCollaborationLifecycle } from './agent-collaboration-tools'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { getMainAgentRenderer as getMainRendererWebContents, assertMainAgentRendererTarget, isMainAgentRenderer } from './agent-renderer-access'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const useUtilityAgentRuntime = process.env.PROMA_AGENT_RUNTIME !== 'in-process'
  && process.env.PROMA_AGENT_RUNTIME !== 'off'
const adapter = useUtilityAgentRuntime ? new PiUtilityAdapter() : new PiAgentAdapter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 只把主进程已核验的 write/edit 提交变成会话来源事件；raw fs 刷新永远不带来源。
configureWorkspaceKnowledgeAttribution({
  isRunCurrent: (owner) => !isAgentSessionDeleting(owner.sessionId) && !!getAgentSessionMeta(owner.sessionId)
    && orchestrator.listActiveSessionSnapshots().some(snapshot => snapshot.sessionId === owner.sessionId && snapshot.runGeneration === owner.runGeneration),
  emit: (change) => {
    eventBus.emit(change.source.sessionId, {
      kind: 'proma_event',
      event: { type: 'knowledge_file_changed', change },
    })
  },
})

// 生命周期必须在接受任何运行前同步订阅；阻塞问题继续通过 EventBus 上浮。
registerCollaborationLifecycle()
registerCollaborationEventBus(eventBus)

/**
 * 会话 → renderer 的流事件投递路由。
 *
 * 每次 run 注册独立 owner；旧 run 只能清理自己仍拥有的 route，不能删除
 * 队列接力或 renderer 重载后被新 run 接管的投递目标。
 */
const streamRoutes = new AgentStreamRouteRegistry<WebContents>()
/** 每个 renderer 当前可见的 Agent 会话；仅该会话维持 20fps partial。 */
const visibleAgentSessionByWebContents = new WeakMap<WebContents, string | null>()
const streamForwarder = new AgentStreamForwarder()
const runDrains = new AgentRunDrainRegistry()
let shuttingDown = false
/** 等待旧轮收尾的 headless 请求也不能覆盖在等待期间发生的新停止。 */
const stopRevisions = new Map<string, number>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册新的 stream route，并在 webContents 销毁时保留 owner 以等待 renderer 重绑或 run 收束。
 */
function attachWebContentsCleanup(wc: WebContents): void {
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 保留 route owner 到活跃 run 收束，允许新 renderer 重绑；取消旧 wc 捕获的 partial。
    for (const sessionIdToClear of streamRoutes.markTargetDestroyed(wc)) {
      streamForwarder.clear(sessionIdToClear)
    }
    visibleAgentSessionByWebContents.delete(wc)
  })
}

function registerWebContents(sessionId: string, wc: WebContents | null) {
  if (wc) assertMainAgentRendererTarget(wc)
  const previousWebContents = streamRoutes.get(sessionId)?.target
  if (previousWebContents && previousWebContents !== wc) streamForwarder.clear(sessionId)
  const route = streamRoutes.bind(sessionId, wc)
  if (wc) attachWebContentsCleanup(wc)
  return route
}

/**
 * 更新已有 run 的 renderer 目标，但绝不能取得新的 owner。
 *
 * 排队或中断消息不创建新 run；若它们调用 bind()，旧 run 的终态将因 owner
 * 不匹配而无法投递，renderer 会永久保留 running 状态。
 */
function rebindWebContents(sessionId: string, wc: WebContents) {
  assertMainAgentRendererTarget(wc)
  const previousWebContents = streamRoutes.get(sessionId)?.target
  if (previousWebContents && previousWebContents !== wc) streamForwarder.clear(sessionId)
  const route = streamRoutes.rebind(sessionId, wc)
  attachWebContentsCleanup(wc)
  return route
}

function getOwnedStreamTarget(sessionId: string, ownerId: number): WebContents | undefined {
  const target = streamRoutes.getTargetIfOwner(sessionId, ownerId)
  return isMainAgentRenderer(target) ? target : undefined
}

function getStreamRouteTargets(): Map<string, WebContents> {
  const targets = new Map<string, WebContents>()
  for (const snapshot of orchestrator.listActiveSessionSnapshots()) {
    const target = streamRoutes.get(snapshot.sessionId)?.target
    if (isMainAgentRenderer(target)) targets.set(snapshot.sessionId, target)
  }
  return targets
}

export function rebindActiveAgentStreams(webContents: WebContents): AgentActiveSessionSnapshot[] {
  assertMainAgentRendererTarget(webContents)
  const snapshots = orchestrator.listActiveSessionSnapshots()
  // headless 无窗启动以及已发业务终态但尚未清理的 run 也保留 owner。
  const sessionIds = new Set([...streamRoutes.sessionIds(), ...snapshots.map(item => item.sessionId)])
  for (const sessionId of sessionIds) {
    if (streamRoutes.get(sessionId)?.target !== webContents) streamForwarder.clear(sessionId)
    streamRoutes.rebind(sessionId, webContents)
  }
  attachWebContentsCleanup(webContents)
  return snapshots
}

const agentQueueCoordinator = new AgentQueueCoordinator({
  isActive: (sessionId) => orchestrator.isActive(sessionId),
  isStartBlocked: (sessionId) => shuttingDown || isAgentSessionDeleting(sessionId)
    || orchestrator.isRunCleanupBlocked(sessionId) || startingAgentSessions.has(sessionId) || !!runDrains.get(sessionId),
  getWebContents: () => getMainRendererWebContents(),
  // started 已被接受后即使窗口销毁，也由原任务继续无窗运行，不静默丢弃消息。
  startRun: (input) => startDesktopAgentRun(input),
  sendStarted: (webContents, status) => {
    if (!webContents.isDestroyed()) webContents.send(AGENT_IPC_CHANNELS.QUEUED_MESSAGE_STATUS, status)
  },
  reserveRunGeneration: (sessionId) => orchestrator.reserveRunGeneration(sessionId),
  // 优先向活跃通道注入；stale 仅回队列，必须等待完整收尾后才能启动新 run。
  inject: async (input, interrupt) => {
    try {
      // queueAgentMessage 的第二参数仅用于满足签名，路由目标仅供阅读时参考。
      const target = getMainRendererWebContents()
      await queueAgentMessage({
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        rawUserMessage: input.rawUserMessage,
        uuid: input.queueMessageId,
        interrupt,
        mentionedSkills: input.mentionedSkills,
        mentionedMcpServers: input.mentionedMcpServers,
        mentionedSessionIds: input.mentionedSessionIds,
        mentionedTodoIds: input.mentionedTodoIds,
        mentionedCalendarEventIds: input.mentionedCalendarEventIds,
      }, target!)
      return true
    } catch (error) {
      if (isStaleActiveQueueError(error)) return false
      throw error
    }
  },
})

/**
 * Renderer run 在创建飞书镜像卡片时尚未进入 orchestrator.activeSessions。
 * 在此期间保留启动槽位，避免会话迁移改变已接受请求的项目归属。
 */
interface AgentStartReservation { stopped: boolean; runGeneration: number }
const startingAgentSessions = new Map<string, AgentStartReservation>()

function assertCanStartAgentRun(sessionId: string, cancelled = false): void {
  if (orchestrator.isRunCleanupBlocked(sessionId)) throw new AgentQueryDrainError(undefined)
  if (!cancelled && (shuttingDown || isAgentSessionDeleting(sessionId))) throw new Error('会话正在删除或应用正在退出')
  if (orchestrator.isActive(sessionId) || runDrains.get(sessionId)) {
    throw new Error('会话仍在运行或收尾，请等待当前请求结束后再发送。')
  }
}

export function reserveAgentSessionStart(sessionId: string): () => void {
  assertCanStartAgentRun(sessionId)
  if (startingAgentSessions.has(sessionId) || agentQueueCoordinator.isDispatching(sessionId) || agentQueueCoordinator.isPromoting(sessionId)) {
    throw new Error('会话正在启动，请等待当前请求结束后再发送。')
  }
  const reservation = { stopped: false, runGeneration: orchestrator.reserveRunGeneration(sessionId) }
  startingAgentSessions.set(sessionId, reservation)
  agentQueueCoordinator.resumeForExplicitInput(sessionId)
  agentQueueCoordinator.onRunAccepted(sessionId, reservation.runGeneration)
  return () => {
    if (startingAgentSessions.get(sessionId) !== reservation) return
    startingAgentSessions.delete(sessionId)
    agentQueueCoordinator.onTargetAvailable(sessionId)
  }
}

export function isAgentSessionBusy(sessionId: string): boolean {
  return startingAgentSessions.has(sessionId)
    || !!runDrains.get(sessionId)
    || orchestrator.isActive(sessionId)
    || orchestrator.isRunCleanupBlocked(sessionId)
    || agentQueueCoordinator.hasPending(sessionId)
}

function publishRunStopped(
  sessionId: string,
  stoppedByUser: boolean | undefined,
  startedAt: number | undefined,
  runGeneration: number | undefined,
): void {
  if (!stoppedByUser) return
  eventBus.emit(sessionId, {
    kind: 'proma_event',
    event: {
      type: 'run_stopped',
      ...(startedAt != null ? { startedAt } : {}),
      ...(runGeneration != null ? { runGeneration } : {}),
    },
  })
}

// ===== EventBus IPC 转发中间件 =====

/**
 * 完成事件只需要侧栏/导航使用的轻量 meta。Pi 的 entry bindings 仅用于主进程
 * session fork/rewind，传到 renderer 会在长会话完成时徒增 IPC 序列化成本。
 */
function getSessionMetaForRenderer(sessionId: string) {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return undefined
  const { piEntryBindings: _piEntryBindings, ...meta } = session
  return meta
}

eventBus.use((sessionId, payload, next) => {
  const wc = streamRoutes.get(sessionId)?.target
  if (isMainAgentRenderer(wc)) {
    try {
      streamForwarder.forward(
        { sessionId, payload } as AgentStreamEvent,
        (event) => { if (isMainAgentRenderer(wc)) wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, event) },
        visibleAgentSessionByWebContents.get(wc) === sessionId,
      )
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  if (payload.kind === 'sdk_message' && payload.message.type === 'system' && payload.message.subtype === 'task_notification') {
    agentQueueCoordinator.onBackgroundTaskComplete(sessionId)
  }
  next()
})

/** renderer 切换标签时更新流式优先级；切入会话立即 flush 等待中的后台快照。 */
export function setVisibleAgentSession(webContents: WebContents, sessionId: string | null): void {
  rebindActiveAgentStreams(webContents)
  const previousSessionId = visibleAgentSessionByWebContents.get(webContents)
  if (previousSessionId && previousSessionId !== sessionId) {
    // 切出后将已排队的前台帧按后台频率重排，避免继续以 20fps 发送。
    streamForwarder.reprioritize(previousSessionId, false)
  }
  visibleAgentSessionByWebContents.set(webContents, sessionId)
  if (sessionId) streamForwarder.promote(sessionId)
  // 重绑本身不派发，避免 submit/promote 事务开始前队首被提前抢走。
  for (const waiting of agentQueueCoordinator.waitingSessionIds()) agentQueueCoordinator.onTargetAvailable(waiting)
}

// ===== IPC 薄包装函数 =====

/** 仅主进程内部使用的单次运行扩展，绝不经 IPC 序列化。 */
type AgentRunInput = AgentSendInput & { runGeneration?: number; cancelledBeforeStart?: boolean }

export interface AgentRunExtensions {
  piCustomTools?: ToolDefinition[]
}

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export function runAgent(input: AgentRunInput, webContents: WebContents): Promise<void> {
  assertMainAgentRendererTarget(webContents)
  const reservation = startingAgentSessions.get(input.sessionId)
  if (!reservation) assertCanStartAgentRun(input.sessionId)
  return startDesktopAgentRun({
    ...input,
    ...(reservation ? { runGeneration: reservation.runGeneration } : {}),
    cancelledBeforeStart: reservation?.stopped ?? false,
  }, !reservation)
}

function acceptRunInput(input: AgentRunInput): AgentRunInput {
  const accepted = { ...input, startedAt: input.startedAt ?? Date.now(), runGeneration: input.runGeneration ?? orchestrator.reserveRunGeneration(input.sessionId) }
  agentQueueCoordinator.onRunAccepted(input.sessionId, accepted.runGeneration)
  return accepted
}

function startDesktopAgentRun(input: AgentRunInput, resumeExplicit = false): Promise<void> {
  const cancelled = input.cancelledBeforeStart === true || shuttingDown
  assertCanStartAgentRun(input.sessionId, cancelled)
  // 镜像准备之前已经接受的输入不能在 await 之后再次覆盖较新的停止意图。
  if (resumeExplicit) agentQueueCoordinator.resumeForExplicitInput(input.sessionId)
  const accepted = acceptRunInput(input)
  return runDrains.track(input.sessionId,
    run => {
      run.stopped ||= cancelled
      return runAgentBody(accepted, run)
    },
    () => agentQueueCoordinator.onRunDrained(input.sessionId))
}

async function runAgentBody(input: AgentRunInput, run: AgentRunDrainRecord): Promise<void> {
  const route = registerWebContents(input.sessionId, getMainRendererWebContents())
  // deferred queue runs carry their queue id as an internal extension.
  const queueMessageId = (input as Partial<AgentDeferredQueueMessageInput>).queueMessageId
  // 开始新一轮执行时清除"完成未确认"与持久化草稿标记。
  // 草稿标记不能只留在 renderer 内存，否则重启后会重新出现在侧栏。
  try {
    updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false, isDraft: false })
  } catch { /* 新会话可能尚未写入索引 */ }
  // 自动任务会话"毕业"：用户手动发消息（非定时触发）即视为接管，标记后该会话回到普通项目列表，
  // 调度器也不再复用它注入新的定时运行。
  if (input.triggeredBy !== 'automation') {
    try {
      const meta = getAgentSessionMeta(input.sessionId)
      if (meta?.sourceAutomationId && !meta.automationGraduated) {
        updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
        // 向渲染进程发送毕业事件，触发 toast 提示
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'automation_graduated' },
        })
      }
    } catch { /* 新会话可能尚未写入索引 */ }
  }
  try {
    await orchestrator.sendMessage({ ...input, cancelledBeforeStart: run.stopped || shuttingDown }, {
      onError: (error, opts) => {
        const target = getOwnedStreamTarget(input.sessionId, route.ownerId)
        if (target) {
          target.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
            ...(opts?.runGeneration != null ? { runGeneration: opts.runGeneration } : input.runGeneration != null ? { runGeneration: input.runGeneration } : {}),
          })
        }
      },
      onComplete: (messages, opts) => {
        run.terminalObserved = true
        notePlanQuotaUsage()
        publishRunStopped(input.sessionId, opts?.stoppedByUser, opts?.startedAt, opts?.runGeneration)
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: {
            type: 'run_completed',
            source: 'desktop',
            stoppedByUser: opts?.stoppedByUser ?? false,
            error: opts?.error,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            finalAssistantUuid: opts?.finalAssistantUuid,
            ...(opts?.startedAt != null ? { startedAt: opts.startedAt } : {}),
            ...(opts?.runGeneration != null ? { runGeneration: opts.runGeneration } : {}),
          },
        })
        const target = getOwnedStreamTarget(input.sessionId, route.ownerId)
        if (target) {
          sendAgentStreamComplete(target, input, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            runGeneration: opts?.runGeneration,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
            // 只读取刚完成的轻量 meta，renderer 可据此增量更新列表，避免再取 5,000+ 条全量会话。
            session: getSessionMetaForRenderer(input.sessionId),
          })
        }
        agentQueueCoordinator.onRunComplete(
          input.sessionId,
          queueMessageId,
          opts?.backgroundTasksPending === true,
          opts?.stoppedByUser === true,
          opts?.runGeneration,
        )
      },
      onRunStarted: ({ startedAt, runGeneration }) => {
        agentQueueCoordinator.onRunStarted(input.sessionId, runGeneration)
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'run_started', startedAt, runGeneration },
        })
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        const target = getOwnedStreamTarget(input.sessionId, route.ownerId)
        if (target) {
          target.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    run.terminalObserved = true
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    const target = getOwnedStreamTarget(input.sessionId, route.ownerId)
    if (target) {
      target.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: errorMessage,
        ...(input.runGeneration != null ? { runGeneration: input.runGeneration } : {}),
      })
      sendAgentStreamComplete(target, input, {
        messages: [],
        stoppedByUser: false,
        startedAt: input.startedAt,
        runGeneration: input.runGeneration,
      })
    }
    agentQueueCoordinator.onRunComplete(input.sessionId, queueMessageId, false, false)
  } finally {
    // 本轮已经收尾；预检前失败（如网络未就绪）走不到 sendMessage 的停止标记
    // 消费点，这里兜底清理，避免该会话后续消息被永久当作已停止而静默丢弃。
    orchestrator.clearStoppedBeforeRun(input.sessionId)
    if (streamRoutes.removeIfOwner(input.sessionId, route.ownerId)) {
      streamForwarder.clear(input.sessionId)
    }
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
): Promise<void> {
  const acceptedStopRevision = stopRevisions.get(input.sessionId) ?? 0
  const previous = runDrains.get(input.sessionId)
  // 协作/Bridge 可在收到业务终态后立即续跑；只等待已终态或已停止的旧 run。
  if (previous?.terminalObserved || previous?.stopped) await previous.promise.catch(() => {})
  const stoppedWhileWaiting = acceptedStopRevision !== (stopRevisions.get(input.sessionId) ?? 0)
  assertCanStartAgentRun(input.sessionId)
  if (startingAgentSessions.has(input.sessionId) || agentQueueCoordinator.isDispatching(input.sessionId) || agentQueueCoordinator.isPromoting(input.sessionId)) {
    throw new Error('会话正在启动，请稍后重试')
  }
  if (!stoppedWhileWaiting) agentQueueCoordinator.resumeForExplicitInput(input.sessionId)
  // 公共 headless 输入不能指定内部身份；在接受时登记，而不是等展示性的 run_started。
  const { runGeneration: _ignored, ...publicInput } = input as AgentSendInput & { runGeneration?: unknown }
  const accepted = acceptRunInput(publicInput)
  return runDrains.track(input.sessionId,
    run => {
      run.stopped ||= stoppedWhileWaiting
      return runAgentHeadlessBody(accepted, callbacks, extensions, run)
    },
    () => agentQueueCoordinator.onRunDrained(input.sessionId))
}

async function runAgentHeadlessBody(
  input: AgentRunInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions: AgentRunExtensions | undefined,
  run: AgentRunDrainRecord,
): Promise<void> {
  // 委派可复用父会话的合法主窗路由；无窗不回退到辅助窗口。
  const wc = getHeadlessAgentRunTarget(
    getStreamRouteTargets(),
    callbacks.originSessionId,
    getMainRendererWebContents,
  )
  // Headless runs originate from automation, delegation, or an external Bridge. Never
  // treat an omitted source as an interactive desktop-user run: custom tools may grant
  // local side effects that cannot be visibly supervised by an external sender.
  const inferredTriggeredBy = callbacks.source === 'delegation' ? 'delegation' : 'external'
  const runInput: AgentRunInput = {
    ...input,
    ...(input.triggeredBy ? {} : { triggeredBy: inferredTriggeredBy }),
    ...(input.startedAt != null ? {} : { startedAt: Date.now() }),
  }
  const startedAt = runInput.startedAt!
  const route = registerWebContents(runInput.sessionId, wc)

  try {
    await orchestrator.sendMessage({ ...runInput, cancelledBeforeStart: run.stopped || shuttingDown }, {
      onError: (error, opts) => {
        callbacks.onError(error, opts)
        const target = route
          ? getOwnedStreamTarget(runInput.sessionId, route.ownerId)
          : undefined
        if (target) {
          target.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: runInput.sessionId,
            error,
            ...(opts?.runGeneration != null ? { runGeneration: opts.runGeneration } : runInput.runGeneration != null ? { runGeneration: runInput.runGeneration } : {}),
          })
        }
      },
      onComplete: (messages, opts) => {
        run.terminalObserved = true
        notePlanQuotaUsage()
        callbacks.onComplete(messages, opts)
        publishRunStopped(runInput.sessionId, opts?.stoppedByUser, opts?.startedAt, opts?.runGeneration)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: {
            type: 'run_completed',
            source: callbacks.source ?? 'bridge',
            stoppedByUser: opts?.stoppedByUser ?? false,
            error: opts?.error,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            finalAssistantUuid: opts?.finalAssistantUuid,
            ...(opts?.startedAt != null ? { startedAt: opts.startedAt } : {}),
            ...(opts?.runGeneration != null ? { runGeneration: opts.runGeneration } : {}),
          },
        })
        const target = route
          ? getOwnedStreamTarget(runInput.sessionId, route.ownerId)
          : undefined
        if (target) {
          sendAgentStreamComplete(target, runInput, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            runGeneration: opts?.runGeneration,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
            // 只读取刚完成的轻量 meta，renderer 可据此增量更新列表，避免再取 5,000+ 条全量会话。
            session: getSessionMetaForRenderer(runInput.sessionId),
          })
        }
        agentQueueCoordinator.onRunComplete(
          runInput.sessionId,
          undefined,
          opts?.backgroundTasksPending === true,
          opts?.stoppedByUser === true,
          opts?.runGeneration,
        )
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        const target = route
          ? getOwnedStreamTarget(runInput.sessionId, route.ownerId)
          : undefined
        if (target) {
          target.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt, runGeneration, userMessage, userMessageUuid }) => {
        agentQueueCoordinator.onRunStarted(runInput.sessionId, runGeneration)
        const session = getAgentSessionMeta(runInput.sessionId)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: session?.workspaceId ?? runInput.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
            runGeneration,
            ...(session ? { session } : {}),
            ...(userMessage !== undefined ? { userMessage } : {}),
            ...(userMessageUuid ? { userMessageUuid } : {}),
          },
        })
      },
    }, extensions)
  } catch (err) {
    run.terminalObserved = true
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    callbacks.onError(errorMessage)
    callbacks.onComplete()
    eventBus.emit(runInput.sessionId, {
      kind: 'proma_event',
      event: { type: 'run_completed', source: callbacks.source ?? 'bridge', stoppedByUser: false, startedAt },
    })
    const target = route
      ? getOwnedStreamTarget(runInput.sessionId, route.ownerId)
      : undefined
    if (target) {
      target.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: runInput.sessionId,
        error: errorMessage,
        ...(runInput.runGeneration != null ? { runGeneration: runInput.runGeneration } : {}),
      })
      sendAgentStreamComplete(target, runInput, {
        messages: [],
        stoppedByUser: false,
        startedAt,
        runGeneration: runInput.runGeneration,
      })
    }
    agentQueueCoordinator.onRunComplete(runInput.sessionId, undefined, false, false)
  } finally {
    // 与桌面路径一致：预检前失败不会经过停止标记消费点，收尾时兜底清理。
    orchestrator.clearStoppedBeforeRun(runInput.sessionId)
    if (route && streamRoutes.removeIfOwner(runInput.sessionId, route.ownerId)) {
      streamForwarder.clear(runInput.sessionId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  stopRevisions.set(sessionId, (stopRevisions.get(sessionId) ?? 0) + 1)
  const run = runDrains.get(sessionId)
  if (run) run.stopped = true
  const reservation = startingAgentSessions.get(sessionId)
  if (reservation) reservation.stopped = true
  // 启动/派发窗口内到达的 stop 需要暂停队列；本地由 reservation/run 标记承接，
  // 不再把 stop 前移到 orchestrator，否则会把取消标记留给后继轮。
  const stopBeforeRun = shouldStopBeforeAgentRun(
    Boolean(reservation),
    agentQueueCoordinator.isDispatching(sessionId),
  )
  if (run || stopBeforeRun) agentQueueCoordinator.pauseForStop(sessionId)
  // 取消绑定 mirror/dispatch/run 各自的已接受身份，不能留下污染后继轮的 session 级标记。
  void Promise.resolve(orchestrator.stop(sessionId)).catch(error => {
    console.error('[Agent 服务] 停止请求失败，仍等待本轮清理:', error)
  })
}

/** DELETE_SESSION 专用：先写入墓碑，再等待已有 utility abort 收束。 */
export async function stopAgentAndDrain(sessionId: string): Promise<void> {
  markAgentSessionDeleting(sessionId)
  agentQueueCoordinator.pauseForStop(sessionId)
  await orchestrator.stopAndDrain(sessionId)
  await runDrains.get(sessionId)?.promise
  if (orchestrator.isRunCleanupBlocked(sessionId)) throw new AgentQueryDrainError(undefined)
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@proma/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 是否存在任意运行中 Agent，供更新器等全局生命周期服务安全判断。 */
export function hasActiveAgentSessions(): boolean {
  return orchestrator.hasActiveSessions() || runDrains.sessionIds().length > 0
    || startingAgentSessions.size > 0 || agentQueueCoordinator.hasDispatching()
}

export function listActiveAgentSessionSnapshots(): AgentActiveSessionSnapshot[] {
  return orchestrator.listActiveSessionSnapshots()
}

export function listQueuedAgentMessages(sessionId: string): AgentQueuedMessageSnapshot[] {
  return agentQueueCoordinator.snapshot(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  shuttingDown = true
  agentQueueCoordinator.shutdown()
  orchestrator.stopAll()
}


/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Proma 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
    input.mentionedTodoIds,
    input.mentionedCalendarEventIds,
  )
}

/**
 * 单一消息提交入口：主进程依据实时运行状态决定注入当前 Agent 或交给 deferred queue。
 * renderer 的 streaming 状态仅用于展示，不能作为发送路由依据。
 */
export async function submitOrEnqueueAgentMessage(
  input: AgentSubmitOrEnqueueInput,
  webContents: WebContents,
): Promise<AgentSubmitOrEnqueueResult> {
  rebindWebContents(input.sessionId, webContents)
  agentQueueCoordinator.resumeForExplicitInput(input.sessionId)

  if (input.dispatch === 'now' && orchestrator.isActive(input.sessionId)) {
    try {
      await queueAgentMessage({
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        rawUserMessage: input.rawUserMessage,
        uuid: input.queueMessageId,
        interrupt: input.interrupt,
        mentionedSkills: input.mentionedSkills,
        mentionedMcpServers: input.mentionedMcpServers,
        mentionedSessionIds: input.mentionedSessionIds,
        mentionedTodoIds: input.mentionedTodoIds,
        mentionedCalendarEventIds: input.mentionedCalendarEventIds,
      }, webContents)
      return { disposition: 'injected' }
    } catch (error) {
      // Pi Utility 在 query 结束、renderer 尚未收到 STREAM_COMPLETE 的窗口会拒绝注入。
      // 该消息尚未被 SDK 接受，安全地降级到主进程队列，而非向用户暴露瞬态错误。
      if (!isStaleActiveQueueError(error)) throw error
      console.warn(`[Agent 服务] 活跃通道已结束，转入 deferred queue: sessionId=${input.sessionId}`)
    }
  }

  const disposition = agentQueueCoordinator.enqueue(input)
  return { disposition: disposition === 'started' ? 'started' : 'queued' }
}

/** 兼容旧调用：仅将消息追加到主进程 deferred queue。 */
export function enqueueAgentQueuedMessage(input: AgentDeferredQueueMessageInput, webContents: WebContents): void {
  rebindWebContents(input.sessionId, webContents)
  agentQueueCoordinator.resumeForExplicitInput(input.sessionId)
  agentQueueCoordinator.enqueue(input)
}

export function cancelAgentQueuedMessage(input: AgentQueuedMessageControlInput): boolean {
  return agentQueueCoordinator.cancel(input)
}

/**
 * 原子提升队列消息为立即发送：出队 → 尽力注入（可软中断）→ 否则直接启动新一轮 run。
 * 渲染进程据此在 injected/dispatched/not_found 之间选择投影处理，避免“先移除再恢复”的竞态。
 */
export async function promoteAgentQueuedMessage(
  input: AgentPromoteQueuedMessageInput,
  webContents: WebContents,
): Promise<AgentPromoteQueuedMessageResult> {
  rebindWebContents(input.sessionId, webContents)
  const disposition = await agentQueueCoordinator.promote(
    input.sessionId,
    input.messageId,
    input.interrupt === true,
  )
  return { disposition }
}

export function moveAgentQueuedMessage(input: AgentMoveQueuedMessageInput): boolean {
  return agentQueueCoordinator.move(input)
}

export function clearAgentQueuedMessages(sessionId: string): void {
  agentQueueCoordinator.clear(sessionId)
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入当前会话的私有工作目录，供 Agent 通过授权的附加目录读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const attachmentsDir = join(sessionDir, 'attachments')
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  const decodedFiles = input.files.map((file) => {
    const buffer = Buffer.from(file.data, 'base64')
    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new Error(`文件超过 100MB 限制: ${file.filename}`)
    }
    return { file, buffer }
  })

  for (const { file, buffer } of decodedFiles) {
    let targetPath = resolveSafeWorkspaceFilePath(attachmentsDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(attachmentsDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(attachmentsDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

const LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE = 'local_project_root_unavailable'

function createLocalProjectRootUnavailableError(projectRootPath: string, status?: string): Error {
  const error = new Error(
    `本地项目根目录不可用: 本地项目根目录不存在或无法访问：${projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
  ) as Error & { code?: string; details?: string[] }
  error.code = LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE
  error.details = status ? [`目录状态: ${status}`] : undefined
  return error
}

function resolveSafeWorkspaceFilePath(workspaceRoot: string, filename: string): string {
  const hasParentTraversal = filename.split(/[\\/]+/).some((segment) => segment === '..')
  if (!filename || isAbsolute(filename) || win32.isAbsolute(filename) || hasParentTraversal) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  const resolvedRoot = resolve(workspaceRoot)
  const targetPath = resolve(resolvedRoot, filename)
  const pathWithinRoot = relative(resolvedRoot, targetPath)
  const escapesRoot = pathWithinRoot === '..'
    || pathWithinRoot.startsWith(`..${sep}`)
    || isAbsolute(pathWithinRoot)

  if (!pathWithinRoot || escapesRoot) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  return targetPath
}

/**
 * 保存文件到项目文件根目录
 *
 * 空白项目写入 Proma 托管的 workspace-files/；本地目录项目直接写入用户选择的原始目录。
 */
function isFileAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}

async function writeUniqueWorkspaceFile(
  workspaceFilesDir: string,
  initialTargetPath: string,
  buffer: Buffer,
  usedPaths: Set<string>,
): Promise<string> {
  const relativeFilename = relative(workspaceFilesDir, initialTargetPath)
  const dotIdx = relativeFilename.lastIndexOf('.')
  const baseName = dotIdx > 0 ? relativeFilename.slice(0, dotIdx) : relativeFilename
  const ext = dotIdx > 0 ? relativeFilename.slice(dotIdx) : ''

  for (let counter = 0; ; counter++) {
    const filename = counter === 0 ? relativeFilename : `${baseName}-${counter}${ext}`
    const targetPath = resolveSafeWorkspaceFilePath(workspaceFilesDir, filename)
    if (usedPaths.has(targetPath)) continue

    await mkdirAsync(dirname(targetPath), { recursive: true })
    try {
      // `wx` 确保另一条 IPC 请求不会在碰撞检查与写入之间覆盖文件；
      // 若目标已存在，则尝试下一个编号后缀。
      await writeFileAsync(targetPath, buffer, { flag: 'wx' })
      usedPaths.add(targetPath)
      return targetPath
    } catch (error) {
      if (isFileAlreadyExistsError(error)) continue
      throw error
    }
  }
}

export async function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): Promise<AgentSavedFile[]> {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug)
  if (!workspace) {
    throw new Error(`指定的 Agent 项目不存在或已删除: ${input.workspaceSlug}`)
  }

  if (workspace.projectRootPath) {
    const status = await getLocalProjectRootStatus(workspace.projectRootPath)
    if (status !== 'available') {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, status)
    }
  }

  const wsFilesDir = workspace.projectRootPath ?? getProjectFilesPath(input.workspaceSlug)
  const files = input.files.map((file) => ({
    file,
    initialTargetPath: resolveSafeWorkspaceFilePath(wsFilesDir, file.filename),
  }))
  const decodedFiles = files.map(({ file, initialTargetPath }) => {
    const buffer = Buffer.from(file.data, 'base64')
    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new Error(`文件超过 100MB 限制: ${file.filename}`)
    }
    return { file, initialTargetPath, buffer }
  })
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const { initialTargetPath, buffer } of decodedFiles) {
    const targetPath = await writeUniqueWorkspaceFile(wsFilesDir, initialTargetPath, buffer, usedPaths)
    const actualFilename = relative(wsFilesDir, targetPath)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
