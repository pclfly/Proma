/**
 * 会话变更请求绑定存储
 *
 * 每个 Agent 会话可关联 0..n 条 GitHub PR；绑定与状态快照都落在
 * `~/.proma/change-requests.json`，使用原子写避免崩溃截断。
 *
 * 该文件只保存 PR 链接与公开状态（标题/分支/检查项），不保存 token、
 * 账户信息或任何云端标识。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChangeRequestBinding,
  ChangeRequestBindingSource,
  ChangeRequestSnapshot,
} from '@proma/shared'
import { normalizeChangeRequestUrl, parseChangeRequestUrl } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

/** 单会话绑定上限：防止一条会话无限累积历史 PR。 */
const MAX_BINDINGS_PER_SESSION = 20
/** 会话条目上限：超出时淘汰最久未更新的会话。 */
const MAX_STORE_SESSIONS = 500

interface ChangeRequestSessionEntry {
  updatedAt: number
  bindings: ChangeRequestBinding[]
}

interface ChangeRequestStoreFile {
  version: 1
  sessions: Record<string, ChangeRequestSessionEntry>
}

/** 元数据变更结果；changed=false 表示内容未变化、未写盘。 */
export interface ChangeRequestStoreMutation {
  bindings: ChangeRequestBinding[]
  changed: boolean
}

/** 默认存储路径：与其它配置一样落在 Proma 配置目录。 */
export function defaultChangeRequestStorePath(): string {
  return join(getConfigDir(), 'change-requests.json')
}

function isBindingSource(value: unknown): value is ChangeRequestBindingSource {
  return value === 'discovered' || value === 'referenced' || value === 'created'
}

function isCheck(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const check = value as Record<string, unknown>
  return typeof check.name === 'string'
    && typeof check.status === 'string'
    && typeof check.conclusion === 'string'
}

function isSnapshot(value: unknown): value is ChangeRequestSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.title === 'string'
    && (snapshot.state === 'OPEN' || snapshot.state === 'MERGED' || snapshot.state === 'CLOSED')
    && typeof snapshot.isDraft === 'boolean'
    && typeof snapshot.headRefName === 'string'
    && typeof snapshot.baseRefName === 'string'
    && typeof snapshot.reviewDecision === 'string'
    && typeof snapshot.mergeable === 'string'
    && Array.isArray(snapshot.checks)
    && snapshot.checks.every(isCheck)
    && typeof snapshot.fetchedAt === 'number'
}

/** 逐字段校验，避免损坏的 JSON 或历史字段把侧栏带崩。 */
function parseBinding(value: unknown): ChangeRequestBinding | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const normalized = typeof raw.url === 'string' ? normalizeChangeRequestUrl(raw.url) : null
  if (!normalized) return null
  const ref = parseChangeRequestUrl(normalized)
  if (!ref) return null
  if (typeof raw.createdAt !== 'number' || !isBindingSource(raw.source)) return null

  const binding: ChangeRequestBinding = {
    url: normalized,
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    source: raw.source,
    createdAt: raw.createdAt,
  }
  if (raw.dismissed === true) binding.dismissed = true
  if (typeof raw.fetchedAt === 'number') binding.fetchedAt = raw.fetchedAt
  if (typeof raw.error === 'string' && raw.error) binding.error = raw.error
  if (isSnapshot(raw.snapshot)) binding.snapshot = raw.snapshot
  return binding
}

function dedupeBindings(bindings: readonly ChangeRequestBinding[]): ChangeRequestBinding[] {
  const seen = new Set<string>()
  const result: ChangeRequestBinding[] = []
  for (const binding of bindings) {
    const key = binding.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(binding)
  }
  return result
}

function sameSnapshot(left: ChangeRequestSnapshot | undefined, right: ChangeRequestSnapshot): boolean {
  if (!left) return false
  if (left.title !== right.title
    || left.state !== right.state
    || left.isDraft !== right.isDraft
    || left.headRefName !== right.headRefName
    || left.baseRefName !== right.baseRefName
    || left.reviewDecision !== right.reviewDecision
    || left.mergeable !== right.mergeable
    || left.checks.length !== right.checks.length) {
    return false
  }
  return left.checks.every((check, index) => {
    const other = right.checks[index]
    return other !== undefined
      && check.name === other.name
      && check.status === other.status
      && check.conclusion === other.conclusion
  })
}

/**
 * 按会话读写 PR 绑定。
 *
 * 所有写操作都是同步的：调用方（轮询器/服务）在主进程内串行执行，
 * 小文件读写比引入异步竞态更可控。
 */
export class ChangeRequestStore {
  private readonly explicitPath?: string
  private cache: ChangeRequestStoreFile | null = null

  constructor(filePath?: string) {
    this.explicitPath = filePath
  }

  get filePath(): string {
    return this.explicitPath ?? defaultChangeRequestStorePath()
  }

  /** 读取会话的绑定（含已隐藏项）；顺序即写入顺序。 */
  list(sessionId: string): ChangeRequestBinding[] {
    const entry = this.read().sessions[sessionId]
    if (!entry) return []
    return dedupeBindings(entry.bindings)
  }

  /** 存在未隐藏绑定的会话 id，供轮询器重建订阅。 */
  listBoundSessions(): string[] {
    const file = this.read()
    return Object.keys(file.sessions).filter((sessionId) => {
      const entry = file.sessions[sessionId]
      return entry !== undefined && entry.bindings.some((binding) => binding.dismissed !== true)
    })
  }

  /**
   * 合并观察到的 PR 链接。
   *
   * `accept` 由调用方提供仓库归属过滤；未通过过滤的链接不会被写入，
   * 这是"同分支不同仓库不串"的最后一道闸。
   */
  merge(
    sessionId: string,
    urls: readonly string[],
    source: ChangeRequestBindingSource,
    accept?: (url: string) => boolean,
    now = Date.now(),
  ): ChangeRequestStoreMutation {
    const current = this.list(sessionId)
    const existingUrls = new Set(current.map((binding) => binding.url.toLowerCase()))
    const added: ChangeRequestBinding[] = []

    for (const url of urls) {
      const normalized = normalizeChangeRequestUrl(url)
      if (!normalized) continue
      if (existingUrls.has(normalized.toLowerCase())) continue
      if (accept && !accept(normalized)) continue
      const ref = parseChangeRequestUrl(normalized)
      if (!ref) continue
      existingUrls.add(normalized.toLowerCase())
      added.push({
        url: normalized,
        host: ref.host,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        source,
        createdAt: now,
      })
    }

    if (added.length === 0) return { bindings: current, changed: false }
    const next = dedupeBindings([...current, ...added]).slice(-MAX_BINDINGS_PER_SESSION)
    this.writeSession(sessionId, next, now)
    return { bindings: next, changed: true }
  }

  /** 写入最新快照；内容一致时不写盘。 */
  setSnapshot(sessionId: string, url: string, snapshot: ChangeRequestSnapshot, now = Date.now()): boolean {
    return this.updateBinding(sessionId, url, (binding) => {
      if (!binding.error && sameSnapshot(binding.snapshot, snapshot)) return null
      return { ...binding, snapshot, fetchedAt: now, error: undefined }
    }, now)
  }

  /** 记录读取失败；相同错误不重复写盘。 */
  setError(sessionId: string, url: string, error: string, now = Date.now()): boolean {
    return this.updateBinding(sessionId, url, (binding) => {
      if (binding.error === error) return null
      return { ...binding, error, fetchedAt: now }
    }, now)
  }

  /** 用户隐藏一条绑定；保留记录，避免被再次自动发现。 */
  dismiss(sessionId: string, url: string, now = Date.now()): ChangeRequestStoreMutation {
    const normalized = normalizeChangeRequestUrl(url)
    const current = this.list(sessionId)
    if (!normalized) return { bindings: current, changed: false }
    let changed = false
    const next = current.map((binding) => {
      if (binding.url.toLowerCase() !== normalized.toLowerCase() || binding.dismissed === true) return binding
      changed = true
      return { ...binding, dismissed: true }
    })
    if (!changed) return { bindings: current, changed: false }
    this.writeSession(sessionId, next, now)
    return { bindings: next, changed: true }
  }

  /** 删除会话的全部绑定（会话被删除时调用）。 */
  removeSession(sessionId: string): boolean {
    const file = this.read()
    if (!(sessionId in file.sessions)) return false
    delete file.sessions[sessionId]
    this.write(file)
    return true
  }

  private updateBinding(
    sessionId: string,
    url: string,
    update: (binding: ChangeRequestBinding) => ChangeRequestBinding | null,
    now: number,
  ): boolean {
    const normalized = normalizeChangeRequestUrl(url)
    if (!normalized) return false
    const current = this.list(sessionId)
    let changed = false
    const next = current.map((binding) => {
      if (binding.url.toLowerCase() !== normalized.toLowerCase()) return binding
      const updated = update(binding)
      if (!updated) return binding
      changed = true
      return updated
    })
    if (!changed) return false
    this.writeSession(sessionId, next, now)
    return true
  }

  private writeSession(sessionId: string, bindings: ChangeRequestBinding[], now: number): void {
    const file = this.read()
    file.sessions[sessionId] = { updatedAt: now, bindings: dedupeBindings(bindings) }
    this.prune(file)
    this.write(file)
  }

  /** 淘汰最久未更新的会话，保证文件不会无限增长。 */
  private prune(file: ChangeRequestStoreFile): void {
    const entries = Object.entries(file.sessions)
    if (entries.length <= MAX_STORE_SESSIONS) return
    entries
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(MAX_STORE_SESSIONS)
      .forEach(([sessionId]) => {
        delete file.sessions[sessionId]
      })
  }

  private read(): ChangeRequestStoreFile {
    if (this.cache) return this.cache
    const empty: ChangeRequestStoreFile = { version: 1, sessions: {} }
    if (!existsSync(this.filePath)) {
      this.cache = empty
      return empty
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
      if (!parsed || typeof parsed !== 'object') {
        this.cache = empty
        return empty
      }
      const rawSessions = (parsed as Record<string, unknown>).sessions
      const sessions: Record<string, ChangeRequestSessionEntry> = {}
      if (rawSessions && typeof rawSessions === 'object') {
        for (const [sessionId, rawEntry] of Object.entries(rawSessions as Record<string, unknown>)) {
          if (!rawEntry || typeof rawEntry !== 'object') continue
          const entry = rawEntry as Record<string, unknown>
          if (!Array.isArray(entry.bindings)) continue
          const bindings = entry.bindings
            .map(parseBinding)
            .filter((binding): binding is ChangeRequestBinding => binding !== null)
          if (bindings.length === 0) continue
          sessions[sessionId] = {
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
            bindings: dedupeBindings(bindings),
          }
        }
      }
      this.cache = { version: 1, sessions }
      return this.cache
    } catch (error) {
      console.warn('[变更请求] 绑定文件读取失败，按空数据继续:', error)
      this.cache = empty
      return empty
    }
  }

  private write(file: ChangeRequestStoreFile): void {
    try {
      writeJsonFileAtomic(this.filePath, file)
      this.cache = file
    } catch (error) {
      // 写失败时丢弃缓存，下次从磁盘重建，避免把未落盘的数据当成事实。
      this.cache = null
      throw error
    }
  }
}
