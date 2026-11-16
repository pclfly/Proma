/**
 * Agent Memory 存储与版本管理。
 *
 * 官方 0.22.0：
 * - 全局画像 `~/.proma/memory/user_profile.md`，预算 5000 UTF-16 code units；
 * - 项目记忆 `~/.proma/agent-workspaces/<slug>/memory/MEMORY.md` 是路由索引，
 *   常驻上下文只注入前 12000 字符，索引预算告警线 3500 字符；
 * - 所有写入经过目录锁、版本号（sha256）、历史版本与审阅记录；
 * - 文件路径逐级解析符号链接，且项目记忆目标必须仍位于 memory/ 内。
 *
 * 本地差异：
 * - 本地 `memory/user-profile.md` 与 `.claude/memory/user-profile.md`（连字符）是
 *   工作区协作画像，属于既有 workspace memory 能力，**不当作官方旧画像迁移源**，
 *   避免被迁移/删除。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { applyMemoryEntryOperations } from './memory-entries'
import type { MemoryEntryChange, MemoryEntryOperation, MemoryEntrySkipped } from './memory-entries'
import { resolveMemoryPath, writeMemoryFileAtomic } from './memory-file-path'
import { listMarkdownFiles } from './memory-search'
import { inspectProjectMap } from './project-map-review'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'

export const MEMORY_WEEK_MS = 7 * 24 * 60 * 60 * 1_000
/** 全局用户画像 5000 UTF-16 code units（官方硬预算）。 */
export const PROFILE_MAX_CHARS = 5_000
/** MEMORY.md 纯路由索引告警预算（官方口径，不拒绝写入）。 */
export const MEMORY_INDEX_MAX_CHARS = 3_500
export const PROFILE_NAME = 'user_profile.md'
export const PREFERENCES_NAME = 'project-preferences.md'
export const PROFILE_NAMES = [PROFILE_NAME, 'user-profile.md'] as const
/** 单个记忆文件最大 512 KiB。 */
export const MAX_MEMORY_BYTES = 512 * 1024

/**
 * 本地工作区协作画像文件名（连字符）。
 * 它是既有 workspace memory 的一等文件，不作为官方旧画像迁移源。
 */
const LOCAL_COLLABORATION_PROFILE = 'user-profile.md'

/** 本地工作区协作画像的一等文件路径；任何官方旧画像迁移都必须避开它。 */
export function isLocalCollaborationProfilePath(workspaceRoot: string, path: string): boolean {
  return path === join(workspaceRoot, 'memory', LOCAL_COLLABORATION_PROFILE)
    || path === join(workspaceRoot, '.claude/memory', LOCAL_COLLABORATION_PROFILE)
}

export interface AgentMemoryWorkspaceRef {
  slug: string
  root: string
}

/** 记忆操作所需的显式上下文；生产由 orchestrator 基于已授权工作区构造。 */
export interface AgentMemoryContext {
  /** 全局记忆根，通常为 `~/.proma/memory`。 */
  globalDir: string
  /** 当前受管工作区根，通常为 `~/.proma/agent-workspaces/<slug>`。 */
  workspaceRoot: string
  /** 当前项目文件根；用户本地项目为 projectRootPath，否则为 workspace-files。 */
  projectRoot: string
  /** 与 projectRoot 对应的稳定项目根（worktree 场景由调用方区分）。 */
  canonicalProjectRoot?: string
  /** 已登记工作区；用于旧画像发现与迁移，只应包含已授权工作区。 */
  workspaces: AgentMemoryWorkspaceRef[]
  /** 自动化/委派/计划模式应设为 false。 */
  allowProfileMigration?: boolean
  /** 与 allowProfileMigration 联动；本地暂无官方项目规则维护工具。 */
  allowInstructionMaintenance?: boolean
  /** false 时 live context 不要求建立缺失文件（只读会话）。 */
  allowMemoryWrites?: boolean
}

export interface MemoryPaths {
  directory: string
  profile: string
  index: string
  preferences: string
}

export interface MemoryFile {
  path: string
  content: string | null
  revision: string
  modifiedAt?: number
}

export interface MemoryReviewState {
  checkedAt?: number
  reviewDue: boolean
}

export interface MemoryHistoryEntry {
  revision: string
  savedAt?: number
  summary?: string
  chars: number
  current: boolean
}

export interface LegacyProfileSource {
  id: string
  workspace: AgentMemoryWorkspaceRef
  path: string
  indexPath: string
}

export interface LegacyProfileInspection {
  sources: LegacyProfileSource[]
  issues: Array<{ path: string; message: string }>
}

export interface DiscoveredLegacyProfile {
  id: string
  workspace: AgentMemoryWorkspaceRef
  profile: MemoryFile
  index: MemoryFile
}

export interface MemorySearchCandidate {
  path: string
  label: string
}

export class ProfileBudgetExceededError extends Error {
  readonly attemptedChars: number

  constructor(attemptedChars: number) {
    super(`Profile 超过 ${PROFILE_MAX_CHARS} 字符，未保存；请整理后重试。`)
    this.name = 'ProfileBudgetExceededError'
    this.attemptedChars = attemptedChars
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeForCompare(path: string): string {
  const normalized = resolveMemoryPath(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertWithinRoot(root: string, candidate: string, message: string): void {
  if (!isWithinRoot(root, candidate)) throw new Error(message)
}

/** 供迁移模块校验旧目录（memory 或 .claude/memory）内的索引目标。 */
export function assertPathWithinRoot(root: string, path: string, message: string): void {
  assertWithinRoot(root, path, message)
}

/** 项目记忆目标必须仍位于 memory/ 物理目录内（符号链接不能把写入带出去）。 */
export function assertProjectMemoryPath(ctx: AgentMemoryContext, path: string): void {
  assertWithinRoot(
    memoryPaths(ctx).directory,
    path,
    `项目记忆路径越界，已拒绝访问: ${path}`,
  )
}

/** 全局记忆管理文件（profile/history/reviews/migrations）必须位于 globalDir 内。 */
export function assertGlobalMemoryPath(ctx: AgentMemoryContext, path: string): void {
  assertWithinRoot(ctx.globalDir, path, `全局记忆路径越界，已拒绝访问: ${path}`)
}

export function assertProfileBudget(content: string): void {
  if (content.length > PROFILE_MAX_CHARS) throw new ProfileBudgetExceededError(content.length)
}

export function memoryRevision(content: string | null): string {
  return createHash('sha256').update(content === null ? 'missing' : `file\0${content}`).digest('hex')
}

export function memoryPaths(ctx: AgentMemoryContext): MemoryPaths {
  const directory = join(ctx.workspaceRoot, 'memory')
  return {
    directory,
    profile: join(ctx.globalDir, PROFILE_NAME),
    index: join(directory, 'MEMORY.md'),
    preferences: join(directory, PREFERENCES_NAME),
  }
}

export function readMemoryFile(path: string): MemoryFile {
  const target = resolveMemoryPath(path)
  let content: string | null = null
  let modifiedAt: number | undefined
  try {
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES) {
      throw new Error(`记忆文件不是普通文件或超过 512 KiB: ${path}`)
    }
    content = readFileSync(target, 'utf8')
    modifiedAt = stat.mtimeMs
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  return { path, content, revision: memoryRevision(content), ...(modifiedAt !== undefined && { modifiedAt }) }
}

/** 读取全局画像前确认画像文件没有通过符号链接逃出 globalDir。 */
export function readGlobalProfile(ctx: AgentMemoryContext): MemoryFile {
  const path = memoryPaths(ctx).profile
  assertGlobalMemoryPath(ctx, path)
  return readMemoryFile(path)
}

export function writeMemoryText(path: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) {
    throw new Error('记忆文件超过 512 KiB，请拆分主题。')
  }
  writeMemoryFileAtomic(path, content)
}

function lockOwnerPid(lock: string): number {
  let raw: string
  try {
    raw = readFileSync(join(lock, 'owner'), 'utf8')
  } catch {
    throw new Error('记忆写锁尚未就绪，请稍后重试。')
  }
  const pid = Number(raw)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('记忆写锁无效，请检查锁文件。')
  return pid
}

/**
 * 跨会话记忆写锁。
 *
 * 锁目录中的 owner 记录 pid；持有进程已退出（ESRCH）时清理后重试，
 * 仍存活则拒绝并发写入。
 */
export function withMemoryLock<T>(ctx: AgentMemoryContext, action: () => T): T {
  const globalDir = resolveMemoryPath(ctx.globalDir)
  mkdirSync(globalDir, { recursive: true })
  const lock = join(globalDir, '.write-lock')
  try {
    mkdirSync(lock)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const stat = lstatSync(lock)
    if (!stat.isDirectory()) throw new Error('记忆写锁不是普通目录，请检查锁文件。')
    const pid = lockOwnerPid(lock)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (probe) {
      if (errorCode(probe) !== 'ESRCH') throw probe
      alive = false
    }
    if (alive) throw new Error('其他会话正在更新记忆，请重新读取后重试。')
    rmSync(lock, { recursive: true })
    mkdirSync(lock)
  }
  try {
    writeTextFileAtomic(join(lock, 'owner'), String(process.pid))
    return action()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

const DEFAULT_PROFILE = `# 全局用户画像

暂无已确认的跨项目偏好。仅记录用户明确表达或有充分证据的稳定事实，不推断、不编造。
`

const DEFAULT_INDEX = `# 项目记忆索引

此文件维护主题入口和适用条件；详细内容按需读取。全局画像由运行时独立加载，不在此维护项目画像副本。

## 主题

暂无已确认的项目记忆。
`

export function ensureMemoryFiles(ctx: AgentMemoryContext): void {
  withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const paths = memoryPaths(ctx)
    const defaults: Array<[string, string]> = [
      [paths.profile, DEFAULT_PROFILE],
      [paths.index, DEFAULT_INDEX],
    ]
    for (const [path, content] of defaults) {
      if (path === paths.profile) assertGlobalMemoryPath(ctx, path)
      else assertProjectMemoryPath(ctx, path)
      if (!readMemoryFile(path).content?.trim()) writeMemoryText(path, content)
    }
  })
}

export function memoryAssociation(ctx: AgentMemoryContext): string {
  const paths = memoryPaths(ctx)
  return `<!-- proma:memory:start -->
## 记忆维护

- **个人层（常驻）**：[user_profile.md](<${paths.profile}>)，跨项目共享，仅记录换个项目也成立的个人背景与稳定偏好。
- **项目护栏层（常驻）**：本文件（AGENTS.md，预算 ≤4000 非空白字符），仅保留不看就会在本项目犯错的子项目结构、常用命令与全局红线；具体模块细节、排障经过和某日状态快照一律下沉到项目 memory/。
- **专题手册层（按需）**：[MEMORY.md](<${paths.index}>) 仅维护一行一条的场景路由索引（预算 ≤3500 字符，不写长篇结论摘要），详细主题按索引按需读取；过期或已合并的存量文件（含历史 project-preferences.md）通过可恢复归档移出有效入口。读取不等于核验，不编造用户事实。
<!-- proma:memory:end -->`
}

export function hasMemoryAssociation(ctx: AgentMemoryContext, content: string): boolean {
  const paths = memoryPaths(ctx)
  return content.includes(paths.index) && content.includes(paths.profile) && content.includes('记忆维护')
}

export function linkProjectMemory(ctx: AgentMemoryContext): void {
  const map = inspectProjectMap(ctx.projectRoot)
  if (map.status === '不可安全修改') throw new Error('项目地图不可安全修改。')
  const legacy = ['CLAUDE.md', 'CLAUDE.MD'].find((name) => existsSync(join(ctx.projectRoot, name)))
  const initial = map.content ?? `# 项目约定
${legacy ? `
请先读取并遵循 [${legacy}](./${legacy}) 中的现有项目规则。
` : ''}`
  const managedBlock = /<!-- proma:memory:start -->[\s\S]*?<!-- proma:memory:end -->/
  const next = managedBlock.test(initial)
    ? initial.replace(managedBlock, () => memoryAssociation(ctx))
    : `${initial.trimEnd()}

${memoryAssociation(ctx)}
`
  writeMemoryText(map.path, next)
}

/** 项目记忆允许的目标：global-profile，或 memory/ 下的一级 Markdown 主题。 */
export function memoryTarget(ctx: AgentMemoryContext, target: string): string {
  const paths = memoryPaths(ctx)
  if (target === 'global-profile') {
    assertGlobalMemoryPath(ctx, paths.profile)
    return paths.profile
  }
  if (
    target === 'MEMORY.md'
    || target === PREFERENCES_NAME
    || /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(target)
  ) {
    if ((PROFILE_NAMES as readonly string[]).includes(target)) {
      throw new Error('用户画像只允许写入 global-profile。项目补充写入 project-preferences.md。')
    }
    const path = join(paths.directory, target)
    const rel = relative(paths.directory, path)
    if (!isAbsolute(rel) && !rel.startsWith('..')) {
      assertProjectMemoryPath(ctx, path)
      return path
    }
  }
  throw new Error('仅支持 global-profile 或当前项目 memory/ 下的 Markdown 主题文件名。')
}

function reviewPath(ctx: AgentMemoryContext, path: string): string {
  return join(ctx.globalDir, 'reviews', `${createHash('sha256').update(resolveMemoryPath(path)).digest('hex')}.json`)
}

export function readMemoryReview(
  ctx: AgentMemoryContext,
  file: MemoryFile,
  now = Date.now(),
): MemoryReviewState {
  let checkedAt: number | undefined
  try {
    const recordPath = reviewPath(ctx, file.path)
    assertGlobalMemoryPath(ctx, recordPath)
    const raw = readMemoryFile(recordPath).content ?? '{}'
    const record: unknown = JSON.parse(raw)
    if (record && typeof record === 'object') {
      const candidate = record as { revision?: unknown; checkedAt?: unknown }
      if (
        candidate.revision === file.revision
        && typeof candidate.checkedAt === 'number'
        && Number.isFinite(candidate.checkedAt)
        && candidate.checkedAt > 0
        && candidate.checkedAt <= now
      ) {
        checkedAt = candidate.checkedAt
      }
    }
  } catch {
    checkedAt = undefined
  }
  return {
    ...(checkedAt !== undefined && { checkedAt }),
    reviewDue: file.modifiedAt !== undefined && now - Math.max(file.modifiedAt, checkedAt ?? 0) > MEMORY_WEEK_MS,
  }
}

function historyDirectory(ctx: AgentMemoryContext, path: string): string {
  return join(ctx.globalDir, 'history', createHash('sha256').update(resolveMemoryPath(path)).digest('hex'))
}

interface MemoryReviewRecord {
  revision: string
  checkedAt: number
  summary: string
}

interface MemoryHistoryMeta {
  revision: string
  savedAt: number
  summary: string
  chars: number
}

function writeHistoryMeta(
  ctx: AgentMemoryContext,
  path: string,
  file: MemoryFile,
  summary: string,
  savedAt: number,
): void {
  if (file.content === null) return
  const directory = historyDirectory(ctx, path)
  assertGlobalMemoryPath(ctx, directory)
  mkdirSync(directory, { recursive: true })
  const meta: MemoryHistoryMeta = {
    revision: file.revision,
    savedAt,
    summary,
    chars: file.content.length,
  }
  writeJsonFileAtomic(join(directory, `${file.revision}.json`), meta)
}

function commitMemoryLocked(
  ctx: AgentMemoryContext,
  path: string,
  before: MemoryFile,
  content: string,
  summary: string,
): MemoryFile {
  if (before.content !== content && normalizeForCompare(path) === normalizeForCompare(memoryPaths(ctx).profile)) {
    assertProfileBudget(content)
  }
  if (before.content !== content) {
    if (before.content !== null) {
      const snapshot = join(historyDirectory(ctx, path), `${before.revision}.md`)
      assertGlobalMemoryPath(ctx, snapshot)
      writeMemoryText(snapshot, before.content)
    }
    assertPathForWrite(ctx, path)
    writeMemoryText(path, content)
  }
  const after = readMemoryFile(path)
  const now = Date.now()
  const recordPath = reviewPath(ctx, path)
  assertGlobalMemoryPath(ctx, recordPath)
  mkdirSync(dirname(recordPath), { recursive: true })
  const record: MemoryReviewRecord = { revision: after.revision, checkedAt: now, summary }
  writeJsonFileAtomic(resolveMemoryPath(recordPath), record)
  if (before.content !== content) writeHistoryMeta(ctx, path, after, summary, now)
  return after
}

/** 写入前按目标类型再做一次边界校验。 */
function assertPathForWrite(ctx: AgentMemoryContext, path: string): void {
  if (normalizeForCompare(path) === normalizeForCompare(memoryPaths(ctx).profile)) {
    assertGlobalMemoryPath(ctx, path)
    return
  }
  assertProjectMemoryPath(ctx, path)
}

export function updateMemory(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  content: string,
  summary: string,
): MemoryFile {
  if (!summary.trim() || !content.trim()) {
    throw new Error('请提供有效内容以及实际核验/更新的依据。')
  }
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const path = memoryTarget(ctx, target)
    const before = readMemoryFile(path)
    if (before.revision !== revision) {
      throw new Error('记忆已被其他会话修改，请重新读取并合并。')
    }
    return commitMemoryLocked(ctx, path, before, content, summary)
  })
}

export interface MemoryEntryUpdateResult extends MemoryFile {
  changes: MemoryEntryChange[]
  skipped: MemoryEntrySkipped[]
}

export function updateMemoryEntries(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  operations: readonly MemoryEntryOperation[],
  summary: string,
): MemoryEntryUpdateResult {
  if (!summary.trim()) throw new Error('请提供实际核验/更新的依据。')
  if (operations.length === 0) throw new Error('请提供至少一条条目操作。')
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const path = memoryTarget(ctx, target)
    const before = readMemoryFile(path)
    if (before.revision !== revision) {
      throw new Error('记忆已被其他会话修改，请重新读取并合并。')
    }
    const applied = applyMemoryEntryOperations(before.content ?? '', operations)
    if (applied.changes.length === 0) {
      return { ...before, changes: [], skipped: applied.skipped }
    }
    const after = commitMemoryLocked(ctx, path, before, applied.content, summary)
    return { ...after, changes: applied.changes, skipped: applied.skipped }
  })
}

export function listMemoryHistory(
  ctx: AgentMemoryContext,
  target: string,
  limit = 20,
): MemoryHistoryEntry[] {
  const path = memoryTarget(ctx, target)
  const current = readMemoryFile(path)
  const entries: MemoryHistoryEntry[] = []
  const directory = historyDirectory(ctx, path)
  assertGlobalMemoryPath(ctx, directory)
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const revision = name.slice(0, -3)
    let content: string | null = null
    let savedAt: number | undefined
    let summary: string | undefined
    try {
      const historyFile = join(directory, name)
      assertGlobalMemoryPath(ctx, historyFile)
      content = readFileSync(historyFile, 'utf8')
      savedAt = statSync(historyFile).mtimeMs
      const metaFile = join(directory, `${revision}.json`)
      assertGlobalMemoryPath(ctx, metaFile)
      const meta: unknown = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (meta && typeof meta === 'object') {
        const candidate = meta as { savedAt?: unknown; summary?: unknown }
        if (typeof candidate.savedAt === 'number') savedAt = candidate.savedAt
        if (typeof candidate.summary === 'string') summary = candidate.summary
      }
    } catch {
      if (content === null) continue
    }
    entries.push({
      revision,
      ...(savedAt !== undefined && { savedAt }),
      ...(summary !== undefined && { summary }),
      chars: content.length,
      current: revision === current.revision,
    })
  }
  if (current.content !== null && !entries.some((entry) => entry.current)) {
    let summary: string | undefined
    try {
      const metaFile = join(directory, `${current.revision}.json`)
      assertGlobalMemoryPath(ctx, metaFile)
      const meta: unknown = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (meta && typeof meta === 'object') {
        const candidate = meta as { summary?: unknown }
        if (typeof candidate.summary === 'string') summary = candidate.summary
      }
    } catch {
      summary = undefined
    }
    entries.push({
      revision: current.revision,
      ...(current.modifiedAt !== undefined && { savedAt: current.modifiedAt }),
      ...(summary !== undefined && { summary }),
      chars: current.content.length,
      current: true,
    })
  }
  return entries
    .sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0))
    .slice(0, Math.max(1, Math.min(limit, 50)))
}

export function readMemoryHistoryVersion(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
): MemoryFile {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('历史版本标识无效。')
  const path = memoryTarget(ctx, target)
  const current = readMemoryFile(path)
  if (current.revision === revision) return current
  const snapshot = join(historyDirectory(ctx, path), `${revision}.md`)
  assertGlobalMemoryPath(ctx, snapshot)
  const file = readMemoryFile(snapshot)
  if (file.content === null) throw new Error('该历史版本不存在或已被清理。')
  return { ...file, path }
}

export function restoreMemoryVersion(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  expectedRevision: string,
  summary?: string,
): MemoryFile {
  const historical = readMemoryHistoryVersion(ctx, target, revision)
  const historicalContent = historical.content
  if (historicalContent === null) throw new Error('该历史版本不存在或已被清理。')
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const path = memoryTarget(ctx, target)
    const before = readMemoryFile(path)
    if (before.revision !== expectedRevision) {
      throw new Error('记忆已被其他会话修改，请刷新后再恢复。')
    }
    return commitMemoryLocked(
      ctx,
      path,
      before,
      historicalContent,
      summary?.trim() || '用户从历史版本恢复。',
    )
  })
}

export function archiveMemoryTheme(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  indexRevision: string,
  indexContent: string,
): string {
  if (target === 'global-profile' || target === 'MEMORY.md') {
    throw new Error('核心记忆不能整体归档；请按条目更新并保留必要事实。')
  }
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const paths = memoryPaths(ctx)
    const source = readMemoryFile(memoryTarget(ctx, target))
    assertProjectMemoryPath(ctx, paths.index)
    const index = readMemoryFile(paths.index)
    if (
      normalizeForCompare(source.path) === normalizeForCompare(paths.profile)
      || normalizeForCompare(source.path) === normalizeForCompare(paths.index)
    ) {
      throw new Error('主题与核心记忆指向同一文件，不能归档。')
    }
    if (source.content === null || source.revision !== revision || index.revision !== indexRevision) {
      throw new Error('主题或索引已变化，请重新读取。')
    }
    if (!indexContent.trim() || indexContent.includes(target)) {
      throw new Error('新索引必须移除被归档主题的入口并保留其他内容。')
    }
    const archive = join(paths.directory, 'archive', `${Date.now()}-${randomUUID()}-${target}`)
    assertProjectMemoryPath(ctx, archive)
    writeMemoryText(archive, source.content)
    writeMemoryText(paths.index, indexContent)
    rmSync(source.path)
    return archive
  })
}

/**
 * 发现旧画像位置。
 *
 * 本地 `memory/user-profile.md` 是既有协作画像，明确排除；只把官方旧名
 * `user_profile.md`（以及 `.claude/memory` 下的两种旧名）当作迁移源。
 */
export function inspectLegacyProfileLocations(ctx: AgentMemoryContext): LegacyProfileInspection {
  const sources: LegacyProfileSource[] = []
  const issues: Array<{ path: string; message: string }> = []
  const seen = new Set<string>()
  try {
    seen.add(resolveMemoryPath(memoryPaths(ctx).profile))
  } catch {
    // 全局画像路径不可解析时，不回退到旧画像覆盖。
  }
  for (const workspace of ctx.workspaces) {
    for (const directory of ['memory', '.claude/memory']) {
      for (const name of PROFILE_NAMES) {
        const path = join(workspace.root, directory, name)
        // 连字符版本是本地协作画像，不参与官方旧画像迁移。
        if (name === LOCAL_COLLABORATION_PROFILE) continue
        try {
          const identity = resolveMemoryPath(path)
          if (seen.has(identity)) continue
          seen.add(identity)
          const stat = statSync(path)
          if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES) {
            throw new Error(`旧画像不是普通文件或超过 512 KiB: ${path}`)
          }
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue
          issues.push({ path, message: errorMessage(error) })
          continue
        }
        sources.push({
          id: createHash('sha256').update(resolve(path)).digest('hex'),
          workspace,
          path,
          indexPath: join(dirname(path), 'MEMORY.md'),
        })
      }
    }
  }
  return { sources, issues }
}

export function listLegacyProfileLocations(ctx: AgentMemoryContext): LegacyProfileSource[] {
  return inspectLegacyProfileLocations(ctx).sources
}

export function discoverLegacyProfiles(
  ctx: AgentMemoryContext,
  sourceId?: string,
): DiscoveredLegacyProfile[] {
  return listLegacyProfileLocations(ctx)
    .filter((item) => !sourceId || item.id === sourceId)
    .map((item) => ({
      id: item.id,
      workspace: item.workspace,
      profile: readMemoryFile(item.path),
      index: readMemoryFile(item.indexPath),
    }))
}

export function pendingMemoryMigrations(ctx: AgentMemoryContext): string[] {
  const directory = join(ctx.globalDir, 'migrations')
  assertGlobalMemoryPath(ctx, directory)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) =>
    /^[a-f0-9-]{36}$/.test(name) && existsSync(join(directory, name, 'pending.json')),
  )
}

export function assertNoPendingMemoryMigration(ctx: AgentMemoryContext): void {
  if (pendingMemoryMigrations(ctx).length > 0) {
    throw new Error('有未完成的画像迁移，请先使用 MemoryMigrateProfile 恢复，再更新记忆。')
  }
}

/** MemorySearch 使用的候选文件与只读读取器；不把 archive/history 当作有效入口。 */
export function buildMemorySearchContext(ctx: AgentMemoryContext): {
  candidates: MemorySearchCandidate[]
  readContent: (path: string) => string | undefined
} {
  const paths = memoryPaths(ctx)
  const candidates: MemorySearchCandidate[] = [{ path: paths.profile, label: PROFILE_NAME }]
  const seen = new Set<string>()
  for (const path of listMarkdownFiles(paths.directory)) {
    let key: string
    try {
      key = resolveMemoryPath(path)
    } catch {
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ path, label: relative(paths.directory, path).split(/[\\/]/).join('/') })
  }
  return {
    candidates,
    readContent: (path: string): string | undefined => {
      try {
        return readMemoryFile(path).content ?? undefined
      } catch {
        return undefined
      }
    },
  }
}

/** 历史/审阅文件所在的全局目录（供迁移模块复用）。 */
export function globalMemoryRoot(ctx: AgentMemoryContext): string {
  return resolveMemoryPath(ctx.globalDir)
}
