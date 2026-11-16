export interface AgentRunDrainRecord {
  readonly promise: Promise<void>
  terminalObserved: boolean
  stopped: boolean
}

/** 业务终态只改变展示；完整 service body（含 finally）结束才释放此运行槽位。 */
export class AgentRunDrainRegistry {
  private readonly runs = new Map<string, AgentRunDrainRecord>()

  get(sessionId: string): AgentRunDrainRecord | undefined { return this.runs.get(sessionId) }
  sessionIds(): string[] { return [...this.runs.keys()] }

  track(
    sessionId: string,
    body: (run: AgentRunDrainRecord) => Promise<void>,
    onDrained: () => void,
  ): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error('上一轮仍在收尾，请稍后重试')
    const run: AgentRunDrainRecord = {
      terminalObserved: false,
      stopped: false,
      // body 在下一微任务才进入，确保普通/headless/queued 首轮均先占槽位。
      promise: Promise.resolve().then(() => body(run)).finally(() => {
        if (this.runs.get(sessionId) !== run) return
        this.runs.delete(sessionId)
        onDrained()
      }),
    }
    this.runs.set(sessionId, run)
    return run.promise
  }
}
