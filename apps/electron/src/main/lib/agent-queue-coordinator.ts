import type { WebContents } from 'electron'
import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentQueuedMessageSnapshot,
  AgentQueuedMessageControlInput,
  AgentQueuedMessageStatus,
} from '@proma/shared'

type DispatchedQueueRunInput = AgentDeferredQueueMessageInput & { runGeneration: number }

interface QueueEntry {
  input: AgentDeferredQueueMessageInput
  queuedAt: number
}

export interface AgentQueueCoordinatorOptions {
  isActive: (sessionId: string) => boolean
  getWebContents: (sessionId: string) => WebContents | null
  startRun: (input: DispatchedQueueRunInput, webContents: WebContents) => Promise<void>
  sendStarted: (webContents: WebContents, status: AgentQueuedMessageStatus) => void
  /** 运行身份由生命周期所有者分配，队列只负责调度。 */
  reserveRunGeneration: (sessionId: string) => number
  /**
   * 尽力向活跃通道注入消息（promote 专用）。返回 false 表示通道已结束（应降级为直接启动 run），
   * 抛错表示真实失败（promote 会把消息回滚到队列并向上传播错误）。
   */
  inject?: (input: AgentDeferredQueueMessageInput, interrupt: boolean) => Promise<boolean>
}

/** 主进程持有 deferred queue；renderer 只保留展示投影。 */
export class AgentQueueCoordinator {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, string>()

  constructor(private readonly options: AgentQueueCoordinatorOptions) {}

  enqueue(input: AgentDeferredQueueMessageInput): 'started' | 'queued' {
    if (this.dispatching.get(input.sessionId) === input.queueMessageId) return 'started'
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.some((entry) => entry.input.queueMessageId === input.queueMessageId)) {
      const runStarted = this.dispatching.get(input.sessionId) === input.queueMessageId
      return runStarted ? 'started' : 'queued'
    }
    queue.push({ input, queuedAt: Date.now() })
    this.queues.set(input.sessionId, queue)
    this.tryDispatch(input.sessionId)
    const runStarted = this.dispatching.get(input.sessionId) === input.queueMessageId
    return runStarted ? 'started' : 'queued'
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const index = queue.findIndex((entry) => entry.input.queueMessageId === input.messageId)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(input.sessionId)
    return true
  }

  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue || input.sourceId === input.targetId) return false
    const sourceIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.sourceId)
    const targetIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0) return false
    const [source] = queue.splice(sourceIndex, 1)
    if (!source) return false
    const adjustedTarget = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    const insertIndex = input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget
    queue.splice(insertIndex, 0, source)
    return true
  }

  onRunComplete(
    sessionId: string,
    queueMessageId: string | undefined,
    backgroundTasksPending: boolean,
    stoppedByUser: boolean,
  ): void {
    if (queueMessageId && this.dispatching.get(sessionId) === queueMessageId) {
      this.dispatching.delete(sessionId)
    }
    if (backgroundTasksPending || stoppedByUser) return
    this.tryDispatch(sessionId)
  }

  onBackgroundTaskComplete(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  /** Renderer/webContents 重新可用后唤醒等待中的队列。tryDispatch 自身负责去重 active/dispatching。 */
  onTargetAvailable(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  snapshot(sessionId: string): AgentQueuedMessageSnapshot[] {
    return (this.queues.get(sessionId) ?? []).map((entry) => ({ input: { ...entry.input }, queuedAt: entry.queuedAt }))
  }

  isDispatching(sessionId: string): boolean {
    return this.dispatching.has(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.dispatching.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  clear(sessionId: string): void {
    this.queues.delete(sessionId)
    this.dispatching.delete(sessionId)
  }

  /** 把用户选中的队列消息提升为立即发送：优先注入活跃通道，降级为直接启动 run。 */
  async promote(
    sessionId: string,
    messageId: string,
    interrupt: boolean,
  ): Promise<'injected' | 'dispatched' | 'not_found'> {
    const queue = this.queues.get(sessionId)
    const index = queue?.findIndex((entry) => entry.input.queueMessageId === messageId) ?? -1
    if (!queue || index < 0) return 'not_found'
    const [entry] = queue.splice(index, 1)
    if (!entry) return 'not_found'
    if (queue.length === 0) this.queues.delete(sessionId)

    // 1) 活跃通道可用时尽力注入（interrupt=true 会软中断当前 turn）。
    if (this.options.inject && this.options.isActive(sessionId)) {
      try {
        if (await this.options.inject(entry.input, interrupt)) return 'injected'
        // inject 返回 false：通道刚结束，消息未被接受，降级为直接启动 run。
      } catch (error) {
        // 真实失败：把消息回滚到原位置，避免静默丢失。
        this.restore(sessionId, entry, index)
        throw error
      }
    }

    // 2) 作为新一轮 run 启动（started 事件与 runGeneration 由 tryDispatch 流程分配）。
    this.startRunEntry(sessionId, entry, index)
    return 'dispatched'
  }

  /** 把消息恢复到队列指定下标（超出范围时夹到队尾），并确保队列 Map 存在。 */
  private restore(sessionId: string, entry: QueueEntry, index: number): void {
    const queue = this.queues.get(sessionId)
    if (!queue) {
      this.queues.set(sessionId, [entry])
      return
    }
    const insertAt = Math.min(Math.max(index, 0), queue.length)
    queue.splice(insertAt, 0, entry)
  }

  private tryDispatch(sessionId: string): void {
    if (this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    const queue = this.queues.get(sessionId)
    const entry = queue?.shift()
    if (!entry) return
    if (queue?.length === 0) this.queues.delete(sessionId)

    this.startRunEntry(sessionId, entry, 0)
  }

  private finishDispatch(sessionId: string, messageId: string): void {
    if (this.dispatching.get(sessionId) === messageId) {
      this.dispatching.delete(sessionId)
      this.tryDispatch(sessionId)
    }
  }

  /** 以指定 entry 启动 run：标记 dispatching、分配 runGeneration、推送 started 投影、执行 startRun。 */
  private startRunEntry(sessionId: string, entry: QueueEntry, restoreIndex: number): void {
    const messageId = entry.input.queueMessageId
    this.dispatching.set(sessionId, messageId)
    const webContents = this.options.getWebContents(sessionId)
    if (!webContents || webContents.isDestroyed()) {
      // 没有可通信的渲染进程：回滚到队列，等待下一次派发。
      this.restore(sessionId, entry, restoreIndex)
      this.dispatching.delete(sessionId)
      return
    }
    const runGeneration = this.options.reserveRunGeneration(sessionId)
    const startedAt = Date.now()
    try {
      this.options.sendStarted(webContents, {
        sessionId,
        messageId,
        status: 'started',
        userMessage: entry.input.userMessage,
        rawUserMessage: entry.input.rawUserMessage,
        startedAt,
        runGeneration,
      })
    } catch {
      // renderer 可能在检查 isDestroyed() 后立即销毁；发送失败时必须保留消息，等待下一次重试。
      this.restore(sessionId, entry, restoreIndex)
      this.dispatching.delete(sessionId)
      return
    }
    void Promise.resolve()
      .then(() => this.options.startRun({ ...entry.input, startedAt, runGeneration, userMessageUuid: messageId }, webContents))
      .then(
        () => this.finishDispatch(sessionId, messageId),
        () => this.finishDispatch(sessionId, messageId),
      )
  }
}
