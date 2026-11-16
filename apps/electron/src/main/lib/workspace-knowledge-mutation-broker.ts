import { createHash, randomUUID } from 'node:crypto'
import type { AttributedKnowledgeChange, KnowledgeChangeDiff, WorkspaceKnowledgeFileRef } from '@proma/shared'
import type { KnowledgeFileWitness, KnowledgeMutationBegin, KnowledgeMutationFinish, KnowledgeMutationObserver, KnowledgeMutationTicket } from './knowledge-mutation-protocol'

export const MAX_KNOWLEDGE_RECEIPT_BYTES = 96 * 1024

export interface KnowledgeMutationScope {
  sessionId: string
  runGeneration: number
  queryId: string
  workspaceId: string
  workspaceSlug: string
}

export interface KnowledgeMutationTarget {
  /** 全局物理路径键，不能按 session/workspace 分锁。 */
  key: string
  /** 已解析的真实目标；仅在需要读取见证时使用，仍是本次授权链的产物。 */
  physicalPath?: string
  logicalPath: string
  /** 原授权根与最近已存在父目录的身份；解析器只读，不创建根目录。 */
  boundaryIdentity: string
  /** 无 file 表示已知但无来源展示资格的 writer，仍参加同路径竞争。 */
  file?: WorkspaceKnowledgeFileRef
}

export interface KnowledgeMutationSnapshot {
  witness: KnowledgeFileWitness
  text?: string
}

interface BrokerOptions {
  resolveTarget: (scope: KnowledgeMutationScope, path: string) => KnowledgeMutationTarget | undefined
  read: (target: KnowledgeMutationTarget) => Promise<KnowledgeMutationSnapshot>
  isCurrent: (scope: KnowledgeMutationScope) => boolean
  emit: (change: AttributedKnowledgeChange) => void
  maxTickets?: number
}
interface ScopeLease { identity: KnowledgeMutationScope; open: boolean }
interface TicketRecord {
  id: string
  lease: ScopeLease
  request: KnowledgeMutationBegin
  target: KnowledgeMutationTarget
  before?: KnowledgeMutationSnapshot
  ambiguous: boolean
  finishing: boolean
  detachAbort: () => void
}
export interface BoundKnowledgeMutationObserver extends KnowledgeMutationObserver {
  /** 只能在该 query 的真实清理结束后调用；停止信号本身不能提前释放竞争记录。 */
  close: () => void
}

function physicalPathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
function sameWitness(left: KnowledgeFileWitness | undefined, right: KnowledgeFileWitness | undefined): boolean {
  if (!left || !right || left.state === 'unsupported' || left.state !== right.state
    || physicalPathKey(left.physicalPath) !== physicalPathKey(right.physicalPath)) return false
  if (left.state === 'missing') return true
  return !!left.version && left.version === right.version && !!left.sha256 && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
}
function boundedText(snapshot: KnowledgeMutationSnapshot): boolean {
  if (snapshot.witness.state === 'missing') return snapshot.text === undefined
  if (snapshot.witness.state !== 'text' || snapshot.text === undefined) return false
  const raw = Buffer.from(snapshot.text, 'utf8')
  return raw.length <= MAX_KNOWLEDGE_RECEIPT_BYTES && raw.length === snapshot.witness.byteLength
    && createHash('sha256').update(raw).digest('hex') === snapshot.witness.sha256
}
function sameTarget(left: KnowledgeMutationTarget, right: KnowledgeMutationTarget | undefined): boolean {
  return !!right && physicalPathKey(left.key) === physicalPathKey(right.key) && left.boundaryIdentity === right.boundaryIdentity
    && JSON.stringify(left.file) === JSON.stringify(right.file)
}

export function createKnowledgeChangeDiff(before: string, after: string): KnowledgeChangeDiff {
  const previous = before.split(/\r?\n/), next = after.split(/\r?\n/)
  let prefix = 0, suffix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  while (suffix < previous.length - prefix && suffix < next.length - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++
  const removed = previous.slice(prefix, previous.length - suffix), added = next.slice(prefix, next.length - suffix)
  const context = previous.slice(Math.max(0, prefix - 1), prefix)
  const truncate = (lines: string[]) => lines.slice(0, 8).map(line => line.slice(0, 256))
  return { context: truncate(context), removed: truncate(removed), added: truncate(added),
    truncated: removed.length > 8 || added.length > 8 || [...context, ...removed, ...added].some(line => line.length > 256) }
}

/**
 * 只归因明确的受控操作前后像，不给 raw watcher 配作者，也不宣称可检测跨进程同字节 ABA。
 * 观测失败仅失去来源展示资格，不能把已成功文件写入变成工具失败或触发重放。
 */
export class WorkspaceKnowledgeMutationBroker {
  private readonly tickets = new Map<string, TicketRecord>()
  private readonly untrackedLeases = new Set<ScopeLease>()
  private permanentlyAmbiguous = false

  constructor(private readonly options: BrokerOptions) {}

  bind(identity: KnowledgeMutationScope): BoundKnowledgeMutationObserver {
    const lease: ScopeLease = { identity: { ...identity }, open: true }
    return {
      begin: (request, signal) => this.begin(lease, request, signal),
      finish: (request, signal) => this.finish(lease, request, signal),
      readWitness: async (request, signal) => {
        const record = this.tickets.get(request.ticketId)
        if (!record || record.lease !== lease || record.request.toolCallId !== request.toolCallId
          || !record.target.file || record.ambiguous || record.finishing || !this.valid(lease) || signal?.aborted) return undefined
        // SDK传入实际操作路径；它必须仍解析到登记凭据时的同一逻辑/物理目标。
        if (!sameTarget(record.target, this.options.resolveTarget(lease.identity, request.path))) return undefined
        const snapshot = await this.options.read(record.target)
        if (!this.valid(lease) || record.ambiguous || signal?.aborted || this.tickets.get(record.id) !== record
          || !sameTarget(record.target, this.options.resolveTarget(lease.identity, request.path))) return undefined
        return snapshot.witness
      },
      resolveWitnessPath: (path: string) => {
        try { return this.options.resolveTarget(lease.identity, path)?.physicalPath } catch { return undefined }
      },
      close: () => {
        lease.open = false
        for (const record of this.tickets.values()) if (record.lease === lease) this.release(record)
        this.untrackedLeases.delete(lease)
      },
    }
  }

  /** 主进程手动保存是已知外部 writer：取消同目标候选，不给它附 Agent 来源。 */
  invalidateTarget(key: string): void {
    for (const record of this.tickets.values()) if (record.target.key === physicalPathKey(key)) record.ambiguous = true
  }

  private valid(lease: ScopeLease): boolean { return lease.open && this.options.isCurrent(lease.identity) }
  private quarantine(lease: ScopeLease): void {
    if (this.untrackedLeases.size < (this.options.maxTickets ?? 128)) this.untrackedLeases.add(lease)
    else this.permanentlyAmbiguous = true // 不无限保存不明 writer；保守停用归因直到进程重启。
    for (const record of this.tickets.values()) record.ambiguous = true
  }
  private release(record: TicketRecord): void {
    record.detachAbort()
    this.tickets.delete(record.id)
  }

  private async begin(lease: ScopeLease, request: KnowledgeMutationBegin, signal?: AbortSignal): Promise<KnowledgeMutationTicket | null> {
    if (!this.valid(lease) || signal?.aborted || !request.toolCallId
      || (request.toolName !== 'write' && request.toolName !== 'edit')) return null
    let target: KnowledgeMutationTarget | undefined
    try { target = this.options.resolveTarget(lease.identity, request.path) } catch { /* 降级，不影响原写入 */ }
    if (!target || this.tickets.size >= (this.options.maxTickets ?? 128)) {
      // 容量满或路径不可证明时不淘汰旧竞争者；该 query 真正关闭前禁止补猜来源。
      this.quarantine(lease)
      return null
    }
    target = { ...target, key: physicalPathKey(target.key) }
    const record: TicketRecord = {
      id: randomUUID(), lease, request: { ...request }, target,
      ambiguous: this.permanentlyAmbiguous || this.untrackedLeases.size > 0, finishing: false, detachAbort: () => {},
    }
    for (const other of this.tickets.values()) {
      if (other.target.key === target.key) { other.ambiguous = true; record.ambiguous = true }
    }
    const onAbort = () => { record.ambiguous = true }
    signal?.addEventListener('abort', onAbort, { once: true })
    record.detachAbort = () => signal?.removeEventListener('abort', onAbort)
    this.tickets.set(record.id, record) // 在任何异步读取之前登记竞争区间。
    try {
      if (target.file) record.before = await this.options.read(target)
    } catch { record.ambiguous = true }
    if (!this.valid(lease) || signal?.aborted || this.tickets.get(record.id) !== record) record.ambiguous = true
    const candidate = !!target.file && !!record.before && boundedText(record.before)
      && physicalPathKey(record.before.witness.physicalPath) === target.key && !record.ambiguous
    if (!candidate) record.ambiguous = true
    return { ticketId: record.id, candidate }
  }

  private async finish(lease: ScopeLease, request: KnowledgeMutationFinish, signal?: AbortSignal): Promise<void> {
    const record = this.tickets.get(request.ticketId)
    // 其他 query 无权消费/取消这个凭据；重复 finish 最多产生一次事件。
    if (!record || record.lease !== lease || record.finishing || record.request.toolCallId !== request.toolCallId) return
    record.finishing = true
    try {
      if (!this.valid(lease) || signal?.aborted || record.ambiguous || !record.target.file || !record.before
        || request.outcome !== 'success' || request.writeCount !== 1
        || !sameWitness(record.before.witness, request.preWrite)
        || (record.request.toolName === 'edit' && !sameWitness(record.before.witness, request.sdkRead))
        || request.observedAfter?.state !== 'text'
        || request.observedAfter.sha256 !== request.expectedAfterSha256
        || request.observedAfter.byteLength !== request.expectedAfterBytes) return
      if (!sameTarget(record.target, this.options.resolveTarget(lease.identity, record.request.path))) return
      const after = await this.options.read(record.target)
      // read 期间新 begin/stop/删除/授权变化均可能发生；最后核验与 emit 之间不再 await。
      if (!this.valid(lease) || signal?.aborted || record.ambiguous || this.tickets.get(record.id) !== record
        || !sameTarget(record.target, this.options.resolveTarget(lease.identity, record.request.path))
        || !boundedText(after) || !sameWitness(after.witness, request.observedAfter)
        || record.before.witness.sha256 === after.witness.sha256) return
      const change: AttributedKnowledgeChange = {
        changeId: record.id, workspaceId: lease.identity.workspaceId, workspaceSlug: lease.identity.workspaceSlug,
        file: record.target.file,
        source: { sessionId: lease.identity.sessionId, runGeneration: lease.identity.runGeneration,
          queryId: lease.identity.queryId, toolCallId: record.request.toolCallId, toolName: record.request.toolName },
        changedAt: Date.now(), kind: record.before.witness.state === 'missing' ? 'created' : 'modified',
        diff: createKnowledgeChangeDiff(record.before.text ?? '', after.text ?? ''),
      }
      this.release(record)
      this.options.emit(change)
    } catch { /* 来源显示失败不能改变原工具结果，更不能诱发文件写入重试。 */ }
    finally { if (this.tickets.get(record.id) === record) this.release(record) }
  }
}
