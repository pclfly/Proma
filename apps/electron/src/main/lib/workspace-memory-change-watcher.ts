import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { WorkspaceMemoryFileChange } from '@proma/shared'
import { getWorkspaceKnowledgePolicy } from './agent-workspace-manager'
import { inspectCanonicalKnowledgeDirectory, knowledgePathKey, knowledgeResolutionBoundary, resolveWorkspaceKnowledgePath, type KnowledgeAccessPolicy, type KnowledgePathResolution } from './workspace-knowledge-access'
import { scanWorkspaceMemoryTree, type WorkspaceMemoryTreeSnapshot } from './workspace-memory-tree'
import { subscribeWorkspaceKnowledgePolicyChanges } from './workspace-knowledge-policy-events'
import { createFileChange } from './file-change-diff'

const MAX_DIFF_FILE_BYTES = 96 * 1024
const CHANGE_DEBOUNCE_MS = 180
const MAX_DIRECTORY_WATCHERS = 128
const MAX_METADATA_WATCHERS = 32
interface FileSnapshot { signature: string; text?: string }
interface TrackedSnapshot extends FileSnapshot { boundary: string }
interface DirectoryWatcher { close: () => void; on: (event: 'error', callback: (error: Error) => void) => unknown }
interface WatchSpec { path: string; names?: Set<string>; metadata: boolean; identity: string }
interface ActiveWatch { watcher: DirectoryWatcher; spec: WatchSpec }
export interface WorkspaceMemoryWatcherDependencies {
  getPolicy?: () => KnowledgeAccessPolicy
  watch?: (path: string, callback: (event: string, filename: string | Buffer | null) => void) => DirectoryWatcher
}
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }

/** 打开后先核对fd身份才读正文；异步替换/权限错误只丢一次刷新，不能读错误目标后再验。 */
function readSnapshot(target: KnowledgePathResolution): FileSnapshot | undefined {
  let file: number | undefined
  try {
    const expected = target.identities.find(item => knowledgePathKey(item.path) === knowledgePathKey(target.physicalPath) && item.kind === 'file')
    if (!expected) return undefined
    file = openSync(target.physicalPath, 'r')
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) return undefined
    if (stat.size > MAX_DIFF_FILE_BYTES) return { signature: `large:${stat.size}:${stat.mtimeMs}` }
    const raw = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < raw.length) { const count = readSync(file, raw, offset, raw.length - offset, offset); if (!count) break; offset += count }
    const end = fstatSync(file)
    if (end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs || offset !== stat.size) return undefined
    return raw.includes(0) ? { signature: `binary:${sha256(raw)}` } : { signature: sha256(raw), text: raw.toString('utf8') }
  } catch { return undefined } finally { if (file !== undefined) closeSync(file) }
}
function createChange(relativePath: string, before: FileSnapshot | undefined, after: FileSnapshot | undefined, changedAt: number): WorkspaceMemoryFileChange | undefined {
  // 复用官方 file-change-diff：快照比较、created/modified/deleted、LCS hunk 与 preview 统一维护。
  const record = createFileChange(relativePath, before, after, changedAt)
  if (!record) return undefined
  if (!record.diffAvailable || !record.diff) {
    return { relativePath, kind: record.kind, changedAt, diffAvailable: false }
  }
  const firstHunk = record.diff.hunks[0]
  return {
    relativePath,
    kind: record.kind,
    changedAt,
    diffAvailable: true,
    preview: record.preview,
    diff: {
      context: firstHunk?.context ?? [],
      removed: firstHunk?.removed.map(line => line.text) ?? [],
      added: firstHunk?.added.map(line => line.text) ?? [],
      truncated: record.diff.truncated || record.diff.hunks.length > 1,
    },
  }
}
function canonicalDirectoryIdentity(path: string): string | undefined {
  try { const stat = inspectCanonicalKnowledgeDirectory(path); return `${stat.dev}:${stat.ino}` } catch { return undefined }
}

/** 每个workspace独立权限上下文；physical watch去重，逻辑别名各自刷新，raw diff不带作者。 */
export class WorkspaceMemoryWatcher {
  private snapshots = new Map<string, TrackedSnapshot>()
  private readonly callbacks = new Set<(change: WorkspaceMemoryFileChange) => void>()
  private readonly activeWatches = new Map<string, ActiveWatch>()
  private readonly rememberedGrantRoots = new Set<string>()
  private readonly getPolicy: () => KnowledgeAccessPolicy
  private readonly watchDirectory: NonNullable<WorkspaceMemoryWatcherDependencies['watch']>
  private readonly unsubscribePolicy: () => void
  private timer?: ReturnType<typeof setTimeout>
  private observedAt?: number
  private baseline = true
  private incompleteCoverage = false
  private epoch = 0
  private closed = false

  constructor(readonly workspaceSlug: string, dependencies: WorkspaceMemoryWatcherDependencies = {}) {
    this.getPolicy = dependencies.getPolicy ?? (() => getWorkspaceKnowledgePolicy(workspaceSlug))
    this.watchDirectory = dependencies.watch ?? ((path, callback) => watch(path, callback))
    this.unsubscribePolicy = subscribeWorkspaceKnowledgePolicyChanges(workspaceSlug, () => this.refreshAccess())
    this.rescan()
  }
  subscribe(callback: (change: WorkspaceMemoryFileChange) => void): () => void {
    if (this.closed) throw new Error('记忆监听已关闭')
    this.callbacks.add(callback)
    return () => { this.callbacks.delete(callback); if (this.callbacks.size === 0) this.close() }
  }
  get diagnostics(): { watches: number; files: number; retainedTextBytes: number; pending: boolean; closed: boolean } {
    return { watches: this.activeWatches.size, files: this.snapshots.size, retainedTextBytes: [...this.snapshots.values()].reduce((size, value) => size + Buffer.byteLength(value.text ?? '', 'utf8'), 0), pending: this.timer !== undefined, closed: this.closed }
  }
  private emit(change: WorkspaceMemoryFileChange, epoch = this.epoch): void {
    for (const callback of [...this.callbacks]) {
      if (this.closed || this.epoch !== epoch) return
      try { callback(change) } catch (error) { console.warn('[工作区记忆] 刷新回调失败:', error) }
    }
  }
  private emitAccessReset(): void { this.emit({ relativePath: '', kind: 'modified', changedAt: Date.now(), diffAvailable: false, accessChanged: true }) }
  private cancelPending(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.observedAt = undefined }
  private releaseWatches(): void { for (const { watcher } of this.activeWatches.values()) watcher.close(); this.activeWatches.clear() }
  private refreshAccess(): void {
    if (this.closed) return
    this.epoch += 1
    this.cancelPending(); this.releaseWatches(); this.snapshots.clear(); this.rememberedGrantRoots.clear(); this.baseline = true; this.incompleteCoverage = false
    this.emitAccessReset() // 同步丢旧正文，不能等下一次文件事件才撤销。
    this.scheduleRescan()
  }
  private scheduleRescan(): void {
    if (this.closed) return
    const firstObservedAt = this.observedAt ?? Date.now()
    if (this.timer) clearTimeout(this.timer)
    this.observedAt = firstObservedAt
    this.timer = setTimeout(() => this.rescan(), CHANGE_DEBOUNCE_MS)
  }

  private desiredWatches(policy: KnowledgeAccessPolicy, tree: WorkspaceMemoryTreeSnapshot): Map<string, WatchSpec> {
    const desired = new Map<string, WatchSpec>()
    let metadataCount = 0, directoryCount = 0
    const add = (path: string, names?: Set<string>, metadata = false): void => {
      const key = knowledgePathKey(path), previous = desired.get(key)
      if (previous) { if (previous.names && names) for (const name of names) previous.names.add(name); else previous.names = undefined; return }
      if (metadata ? metadataCount >= MAX_METADATA_WATCHERS : directoryCount >= MAX_DIRECTORY_WATCHERS) return
      const identity = canonicalDirectoryIdentity(path)
      if (!identity) return
      if (metadata) metadataCount += 1; else directoryCount += 1
      desired.set(key, { path, names, metadata, identity })
    }
    // parent只能监听原名称是否恢复；不枚举、不读取未授权兄弟。
    add(dirname(policy.logicalRoot), new Set([basename(policy.logicalRoot)]), true)
    const configured = new Set(policy.authorizedDirectories.map(knowledgePathKey))
    for (const root of [...this.rememberedGrantRoots]) if (!configured.has(knowledgePathKey(root))) this.rememberedGrantRoots.delete(root)
    for (const item of [...tree.directories, ...tree.files]) if (configured.has(knowledgePathKey(item.target.allowedRoot))) this.rememberedGrantRoots.add(item.target.allowedRoot)
    for (const root of this.rememberedGrantRoots) add(dirname(root), new Set([basename(root)]), true)
    for (const directory of tree.directories) add(directory.target.physicalPath)
    // 最终文件链接仅消费其basename；同目录的其他文件不会成为memory条目。
    for (const file of tree.files) add(dirname(file.target.physicalPath), new Set([basename(file.target.physicalPath)]))
    return desired
  }
  private reconcileWatches(desired: Map<string, WatchSpec>): void {
    for (const [key, active] of this.activeWatches) if (!desired.has(key)) { active.watcher.close(); this.activeWatches.delete(key) }
    for (const [key, spec] of desired) {
      const existing = this.activeWatches.get(key)
      if (existing?.spec.identity === spec.identity) { existing.spec = spec; continue }
      if (existing) { existing.watcher.close(); this.activeWatches.delete(key) }
      try {
        const watcher = this.watchDirectory(spec.path, (_event, filename) => {
          const active = this.activeWatches.get(key)
          if (this.closed || !active || active.watcher !== watcher || (filename !== null && active.spec.names && !active.spec.names.has(filename.toString()))) return
          this.scheduleRescan()
        })
        watcher.on('error', () => { if (this.activeWatches.get(key)?.watcher !== watcher) return; this.activeWatches.delete(key); watcher.close(); this.scheduleRescan() })
        this.activeWatches.set(key, { watcher, spec })
      } catch { /* 下一次受限刷新再建立；失败不放宽授权根。 */ }
    }
  }

  /** 可用于显式刷新及合成事件测试；每次消费前重读权限与逻辑映射。 */
  rescan(): void {
    if (this.closed) return
    const observedAt = this.observedAt ?? Date.now()
    const epoch = ++this.epoch
    this.cancelPending()
    try {
      const policy = this.getPolicy()
      const tree = scanWorkspaceMemoryTree(policy, { inspectText: false })
      this.reconcileWatches(this.desiredWatches(policy, tree))
      const next = new Map<string, TrackedSnapshot>()
      const changes: WorkspaceMemoryFileChange[] = []
      const currentPaths = new Set(tree.files.map(file => file.relativePath))
      const physicalSnapshots = new Map<string, FileSnapshot | undefined>()
      let reset = !!tree.rootAccess.blockedReason
      for (const file of tree.files) {
        try {
          // 不使用扫描阶段过期的路径许可；open后的fd还要与当前目标身份一致。
          const current = resolveWorkspaceKnowledgePath(this.getPolicy(), file.relativePath)
          const fileIdentity = current.identities.find(item => item.kind === 'file' && knowledgePathKey(item.path) === knowledgePathKey(current.physicalPath))
          const boundary = knowledgeResolutionBoundary(current), key = `${knowledgePathKey(current.physicalPath)}:${fileIdentity?.dev}:${fileIdentity?.ino}:${current.size}:${current.modifiedAt}`
          const before = this.snapshots.get(file.relativePath)
          if (before && before.boundary !== boundary) reset = true
          if (!physicalSnapshots.has(key)) physicalSnapshots.set(key, readSnapshot(current))
          const after = physicalSnapshots.get(key)
          if (!after) { reset = true; continue }
          next.set(file.relativePath, { ...after, boundary })
          const change = !before && this.incompleteCoverage ? undefined : createChange(file.relativePath, before, after, observedAt)
          if (change) changes.push(change)
        } catch { reset = true }
      }
      for (const [path, before] of this.snapshots) {
        if (currentPaths.has(path) || tree.truncated) continue // 预算遗漏不是删除。
        try {
          const current = resolveWorkspaceKnowledgePath(this.getPolicy(), path, { allowMissing: true })
          if (current.kind !== 'missing' || before.boundary !== knowledgeResolutionBoundary(current)) { reset = true; continue }
          const change = createChange(path, before, undefined, observedAt)
          if (change) changes.push(change)
        } catch { reset = true } // 撤销/改向不能携带旧正文伪装成delete diff。
      }
      if (epoch !== this.epoch || this.closed) return
      this.snapshots = next
      this.incompleteCoverage = tree.truncated
      const emitChanges = !this.baseline
      this.baseline = false // 回调可同步撤销/重扫；不得在回调后覆盖其新baseline。
      if (emitChanges) { if (reset) this.emitAccessReset(); else for (const change of changes) { if (epoch !== this.epoch) break; this.emit(change, epoch) } }
    } catch {
      if (epoch !== this.epoch || this.closed) return
      this.releaseWatches(); this.snapshots.clear(); this.rememberedGrantRoots.clear()
      if (!this.baseline) this.emitAccessReset()
      this.baseline = true
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; this.epoch += 1; this.cancelPending(); this.releaseWatches(); this.snapshots.clear(); this.rememberedGrantRoots.clear(); this.callbacks.clear(); this.unsubscribePolicy()
    if (watchersByWorkspace.get(this.workspaceSlug) === this) watchersByWorkspace.delete(this.workspaceSlug)
  }
}

const watchersByWorkspace = new Map<string, WorkspaceMemoryWatcher>()
export function subscribeWorkspaceMemoryChanges(workspaceSlug: string, callback: (change: WorkspaceMemoryFileChange) => void): () => void {
  // 只验证已登记工作区；不因订阅而创建/迁移根，不按外置物理目录跨workspace共享权限。
  getWorkspaceKnowledgePolicy(workspaceSlug)
  let watcher = watchersByWorkspace.get(workspaceSlug)
  if (!watcher) { watcher = new WorkspaceMemoryWatcher(workspaceSlug); watchersByWorkspace.set(workspaceSlug, watcher) }
  return watcher.subscribe(callback)
}
