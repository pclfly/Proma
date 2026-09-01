import type { WebContents } from 'electron'
import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentQueuedMessageControlInput,
  AgentQueuedMessageStatus,
} from '@proma/shared'

interface QueueEntry {
  input: AgentDeferredQueueMessageInput
}

export interface AgentQueueCoordinatorOptions {
  isActive: (sessionId: string) => boolean
  getWebContents: (sessionId: string) => WebContents | null
  startRun: (input: AgentDeferredQueueMessageInput, webContents: WebContents) => Promise<void>
  sendStarted: (webContents: WebContents, status: AgentQueuedMessageStatus) => void
  /**
   * 尽力向活跃通道注入消息。返回 false 表示通道已结束（应降级为直接启动 run），
   * 抛错表示真实失败（promote 会把消息回滚到队列并向上传播错误）。
   */
  inject?: (input: AgentDeferredQueueMessageInput, interrupt: boolean) => Promise<boolean>
}

/** 主进程持有 deferred queue；renderer 只保留展示投影。 */
export class AgentQueueCoordinator {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, string>()

  constructor(private readonly options: AgentQueueCoordinatorOptions) {}

  enqueue(input: AgentDeferredQueueMessageInput): void {
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.some((entry) => entry.input.queueMessageId === input.queueMessageId)) return
    queue.push({ input })
    this.queues.set(input.sessionId, queue)
    this.tryDispatch(input.sessionId)
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

  /**
   * 原子提升队列消息为立即发送：出队后先尝试注入活跃通道（可软中断），
   * 通道已结束则直接启动新一轮 run。保证消息要么被注入/派发，要么回滚留在队列。
   */
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

    // 2) 作为新一轮 run 启动（started 事件由 startRunEntry 推送）。
    this.startRunEntry(sessionId, entry, index)
    return 'dispatched'
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

  private tryDispatch(sessionId: string): void {
    if (this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    const queue = this.queues.get(sessionId)
    const entry = queue?.shift()
    if (!entry) return
    if (queue?.length === 0) this.queues.delete(sessionId)

    this.startRunEntry(sessionId, entry, 0)
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

  /** 以指定 entry 启动 run：标记 dispatching、推送 started 投影、执行 startRun。 */
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
    const startedAt = Date.now()
    this.options.sendStarted(webContents, {
        sessionId,
        messageId,
        status: 'started',
        userMessage: entry.input.userMessage,
        rawUserMessage: entry.input.rawUserMessage,
        startedAt,
    })
    void this.options.startRun({ ...entry.input, startedAt, userMessageUuid: messageId }, webContents)
      .finally(() => {
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
      })
  }
}
