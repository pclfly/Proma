import type { WebContents } from 'electron'
import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentQueuedMessageSnapshot,
  AgentQueuedMessageControlInput,
  AgentQueuedMessageStatus,
} from '@proma/shared'

type DispatchedQueueRunInput = AgentDeferredQueueMessageInput & { runGeneration: number; cancelledBeforeStart: boolean }
interface QueueEntry { input: AgentDeferredQueueMessageInput; queuedAt: number }
interface QueueDispatch { messageId: string; token: symbol; cancelledBeforeStart: boolean }
interface QueueControl {
  paused: boolean
  revision: number
  runRevision: number
  runGeneration?: number
  backgroundPending: boolean
  promotion?: { messageId: string; token: symbol }
}

export interface AgentQueueCoordinatorOptions {
  isActive: (sessionId: string) => boolean
  /** 镜像准备、完整运行收尾、删除与退出均阻止新 run；不用于判断能否同轮注入。 */
  isStartBlocked?: (sessionId: string) => boolean
  getWebContents: (sessionId: string) => WebContents | null
  startRun: (input: DispatchedQueueRunInput, webContents: WebContents) => Promise<void>
  sendStarted: (webContents: WebContents, status: AgentQueuedMessageStatus) => void
  reserveRunGeneration: (sessionId: string) => number
  /** false 仅说明旧通道未接受消息；消息必须回队列等待统一准入，不能直接开新 run。 */
  inject?: (input: AgentDeferredQueueMessageInput, interrupt: boolean) => Promise<boolean>
}

/** 主进程持有 deferred queue；所有新 run 共用准入检查，renderer 只保留展示投影。 */
export class AgentQueueCoordinator {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, QueueDispatch>()
  private readonly controls = new Map<string, QueueControl>()
  private shuttingDown = false

  constructor(private readonly options: AgentQueueCoordinatorOptions) {}

  private control(sessionId: string): QueueControl {
    let control = this.controls.get(sessionId)
    if (!control) {
      control = { paused: false, revision: 0, runRevision: 0, backgroundPending: false }
      this.controls.set(sessionId, control)
    }
    return control
  }

  enqueue(input: AgentDeferredQueueMessageInput): 'started' | 'queued' {
    if (this.dispatching.get(input.sessionId)?.messageId === input.queueMessageId) return 'started'
    if (this.control(input.sessionId).promotion?.messageId === input.queueMessageId) return 'queued'
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.some(entry => entry.input.queueMessageId === input.queueMessageId)) return 'queued'
    queue.push({ input, queuedAt: Date.now() })
    this.queues.set(input.sessionId, queue)
    this.tryDispatch(input.sessionId)
    return this.dispatching.get(input.sessionId)?.messageId === input.queueMessageId ? 'started' : 'queued'
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const index = queue.findIndex(entry => entry.input.queueMessageId === input.messageId)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(input.sessionId)
    return true
  }

  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue || input.sourceId === input.targetId) return false
    const sourceIndex = queue.findIndex(entry => entry.input.queueMessageId === input.sourceId)
    const targetIndex = queue.findIndex(entry => entry.input.queueMessageId === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0) return false
    const [source] = queue.splice(sourceIndex, 1)
    if (!source) return false
    const adjustedTarget = queue.findIndex(entry => entry.input.queueMessageId === input.targetId)
    queue.splice(input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget, 0, source)
    return true
  }

  /** 接受时登记控制版本，不能等预检后才把较新的 stop/resume 当作旧轮意图。 */
  onRunAccepted(sessionId: string, runGeneration: number): void {
    const control = this.control(sessionId)
    if (control.runGeneration != null && control.runGeneration >= runGeneration) return
    control.runGeneration = runGeneration
    control.runRevision = control.revision
    control.backgroundPending = false
  }

  onRunStarted(sessionId: string, runGeneration: number): void {
    this.onRunAccepted(sessionId, runGeneration)
  }

  /** 业务完成不代表 finally 已结束，绝不在此释放 dispatch reservation。 */
  onRunComplete(sessionId: string, _queueMessageId: string | undefined, backgroundTasksPending: boolean, stoppedByUser: boolean, runGeneration?: number): void {
    const control = this.control(sessionId)
    if (runGeneration != null && control.runGeneration != null && control.runGeneration !== runGeneration) return
    const backgroundSettled = control.backgroundPending && !backgroundTasksPending
    control.backgroundPending = backgroundTasksPending
    // 显式 stop/resume 比迟到的旧终态更权威。
    if (stoppedByUser && control.revision === control.runRevision) control.paused = true
    // 最终背景完成可能晚于唯一一次 drain；仍由统一准入检查真实运行屏障。
    if (backgroundSettled) this.tryDispatch(sessionId)
  }

  onRunDrained(sessionId: string): void {
    const control = this.control(sessionId)
    if (control.paused) control.backgroundPending = false
    this.tryDispatch(sessionId)
  }
  onBackgroundTaskComplete(sessionId: string): void { this.tryDispatch(sessionId) }
  onTargetAvailable(sessionId: string): void { this.tryDispatch(sessionId) }
  waitingSessionIds(): string[] { return [...this.queues.keys()] }
  hasDispatching(): boolean { return this.dispatching.size > 0 || [...this.controls.values()].some(control => !!control.promotion) }
  isPromoting(sessionId: string): boolean { return !!this.controls.get(sessionId)?.promotion }

  pauseForStop(sessionId: string): void {
    const control = this.control(sessionId)
    control.paused = true
    control.revision++
    const dispatch = this.dispatching.get(sessionId)
    if (dispatch) dispatch.cancelledBeforeStart = true
  }
  /** 只由显式输入调用；不会绕过仍在进行的 drain/starting。 */
  resumeForExplicitInput(sessionId: string): void {
    const control = this.control(sessionId)
    control.paused = false
    control.revision++
  }
  shutdown(): void { this.shuttingDown = true }

  snapshot(sessionId: string): AgentQueuedMessageSnapshot[] {
    return (this.queues.get(sessionId) ?? []).map(entry => ({ input: { ...entry.input }, queuedAt: entry.queuedAt }))
  }
  isDispatching(sessionId: string): boolean { return this.dispatching.has(sessionId) }
  hasPending(sessionId: string): boolean { return this.isDispatching(sessionId) || this.isPromoting(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0 }

  clear(sessionId: string): void {
    this.queues.delete(sessionId)
    // 替换控制身份，让旧 promote 的迟到分支不能恢复已经清掉的消息。
    this.controls.delete(sessionId)
    // 运行 reservation 只能由自己的 Promise settle 清理，clear 不是 abort/drain。
  }

  async promote(sessionId: string, messageId: string, interrupt: boolean): Promise<'injected' | 'dispatched' | 'queued' | 'not_found'> {
    const control = this.control(sessionId)
    if (control.promotion?.messageId === messageId) return 'queued'
    const queue = this.queues.get(sessionId)
    const index = queue?.findIndex(entry => entry.input.queueMessageId === messageId) ?? -1
    if (!queue || index < 0) return 'not_found'
    if (control.promotion) throw new Error('队列消息正在处理，请稍后重试')
    this.resumeForExplicitInput(sessionId)
    const [entry] = queue.splice(index, 1)
    if (!entry) return 'not_found'
    if (!queue.length) this.queues.delete(sessionId)
    const promotion = { messageId, token: Symbol(messageId) }
    control.promotion = promotion
    let injected = false
    try {
      if (this.options.inject && this.options.isActive(sessionId)) {
        injected = await this.options.inject(entry.input, interrupt)
        if (injected) return 'injected'
      }
      if (this.controls.get(sessionId) !== control) return 'not_found'
      this.restore(sessionId, entry, 0)
    } catch (error) {
      if (this.controls.get(sessionId) === control) this.restore(sessionId, entry, index)
      throw error
    } finally {
      if (control.promotion === promotion) control.promotion = undefined
      // 注入等待期间可能已经收到 drain/target 唤醒，事务释放后补一次安全调度。
      if (this.controls.get(sessionId) === control) this.tryDispatch(sessionId)
    }
    this.tryDispatch(sessionId)
    return this.dispatching.get(sessionId)?.messageId === messageId ? 'dispatched' : 'queued'
  }

  private restore(sessionId: string, entry: QueueEntry, index: number): void {
    const queue = this.queues.get(sessionId) ?? []
    queue.splice(Math.min(Math.max(index, 0), queue.length), 0, entry)
    this.queues.set(sessionId, queue)
  }

  private tryDispatch(sessionId: string): void {
    const control = this.control(sessionId)
    if (this.shuttingDown || control.paused || control.backgroundPending || control.promotion
      || this.dispatching.has(sessionId) || this.options.isActive(sessionId) || this.options.isStartBlocked?.(sessionId)) return
    const queue = this.queues.get(sessionId)
    const entry = queue?.[0]
    if (!entry) return
    const webContents = this.options.getWebContents(sessionId)
    if (!webContents || webContents.isDestroyed()) return
    const dispatch = { messageId: entry.input.queueMessageId, token: Symbol(entry.input.queueMessageId), cancelledBeforeStart: false }
    this.dispatching.set(sessionId, dispatch)
    let runGeneration: number
    const startedAt = Date.now()
    try {
      runGeneration = this.options.reserveRunGeneration(sessionId)
      this.onRunAccepted(sessionId, runGeneration)
      this.options.sendStarted(webContents, {
        sessionId, messageId: dispatch.messageId, status: 'started',
        userMessage: entry.input.userMessage, rawUserMessage: entry.input.rawUserMessage, startedAt, runGeneration,
      })
    } catch {
      this.dispatching.delete(sessionId)
      return // 目标销毁/发送失败不出队，也不假报 started。
    }
    queue!.shift()
    if (!queue!.length) this.queues.delete(sessionId)
    const finish = (): void => {
      if (this.dispatching.get(sessionId) !== dispatch) return
      this.dispatching.delete(sessionId)
      this.tryDispatch(sessionId)
    }
    void Promise.resolve()
      .then(() => this.options.startRun({ ...entry.input, startedAt, runGeneration, userMessageUuid: dispatch.messageId, cancelledBeforeStart: dispatch.cancelledBeforeStart || this.shuttingDown }, webContents))
      .then(finish, finish)
  }
}
