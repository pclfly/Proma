/**
 * 旧用户画像迁移。
 *
 * 官方 0.22.0：
 * - 语义合并到全局 Profile，并同步源项目 MEMORY.md / project-preferences.md；
 * - 迁移前写 pending.json 日志，源画像留档到 migrations/<id>/source-profile.md；
 * - 任何版本变化、共享入口或写后校验失败都保留源文件；
 * - pending 记录存在时禁止普通记忆写入，必须先 resume 或 replan。
 *
 * 本地差异：`memory/user-profile.md` 是既有工作区协作画像，不是官方旧画像，
 * 迁移源与迁移目标都显式拒绝它，避免本地能力被官方迁移删除。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  assertGlobalMemoryPath,
  assertNoPendingMemoryMigration,
  assertPathWithinRoot,
  assertProfileBudget,
  assertProjectMemoryPath,
  discoverLegacyProfiles,
  isLocalCollaborationProfilePath,
  memoryPaths,
  readGlobalProfile,
  readMemoryFile,
  writeMemoryText,
  withMemoryLock,
  type AgentMemoryContext,
  type AgentMemoryWorkspaceRef,
  type MemoryFile,
} from './agent-memory'
import { resolveMemoryPath } from './memory-file-path'
import { writeJsonFileAtomic } from './safe-file'

export interface MemoryMigrationProposal {
  sourceId: string
  sourceRevision: string
  globalRevision: string
  globalContent: string
  preferencesRevision: string
  preferencesContent: string | null
  sourceIndexRevision: string
  sourceIndexContent: string
  indexRevision: string
  indexContent: string
  rationale: string
}

type MemoryMigrationTarget = 'global' | 'preferences' | 'source-index' | 'index'

interface MemoryMigrationEdit {
  target: MemoryMigrationTarget
  before: string | null
  after: string
}

interface MemoryMigrationJournal {
  id: string
  sourceId: string
  workspaceRoot: string
  sourcePath: string
  sourceContent: string
  rationale: string
  createdAt: number
  edits: MemoryMigrationEdit[]
}

const MIGRATION_ID = /^[a-f0-9-]{36}$/
const MAX_MIGRATION_FILE_BYTES = 8 * 1024 * 1024
const LEGACY_DIRECTORIES = ['memory', '.claude/memory'] as const
const LEGACY_NAMES = ['user_profile.md', 'user-profile.md'] as const

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function assertProfileMigrationAllowed(ctx: AgentMemoryContext): void {
  if (ctx.allowProfileMigration === false || ctx.allowInstructionMaintenance === false) {
    throw new Error('当前会话不允许整合用户画像；请在可写的用户项目会话中处理。')
  }
}

function assertRevision(file: MemoryFile, revision: string): void {
  if (file.revision !== revision) {
    throw new Error(`迁移期间文件已变化，请重新读取并合并: ${file.path}`)
  }
}

function migrationWorkspace(
  ctx: AgentMemoryContext,
  journal: Pick<MemoryMigrationJournal, 'workspaceRoot' | 'sourcePath'>,
): AgentMemoryWorkspaceRef {
  const workspace = ctx.workspaces.find((item) => samePath(item.root, journal.workspaceRoot))
  if (!workspace) throw new Error('迁移源不在已登记的 workspace 中。')
  return workspace
}

function migrationTargets(
  ctx: AgentMemoryContext,
  journal: Pick<MemoryMigrationJournal, 'workspaceRoot' | 'sourcePath' | 'sourceContent' | 'edits'>,
): { targets: Record<MemoryMigrationTarget, string>; workspace: AgentMemoryWorkspaceRef } {
  const workspace = migrationWorkspace(ctx, journal)
  if (!isAbsolute(journal.workspaceRoot) || !isAbsolute(journal.sourcePath)) {
    throw new Error('迁移源必须使用绝对路径。')
  }
  const allowedSource = LEGACY_DIRECTORIES.some((directory) =>
    LEGACY_NAMES.some((name) => samePath(join(workspace.root, directory, name), journal.sourcePath)),
  )
  if (!allowedSource || isLocalCollaborationProfilePath(workspace.root, journal.sourcePath)) {
    throw new Error('迁移源不在已登记的旧画像目录，或属于本地协作画像。')
  }
  const paths = memoryPaths({ ...ctx, workspaceRoot: workspace.root })
  const targets: Record<MemoryMigrationTarget, string> = {
    global: paths.profile,
    preferences: paths.preferences,
    'source-index': join(dirname(journal.sourcePath), 'MEMORY.md'),
    index: paths.index,
  }
  if (
    typeof journal.sourceContent !== 'string'
    || Buffer.byteLength(journal.sourceContent) > 512 * 1024
    || !Array.isArray(journal.edits)
    || journal.edits[0]?.target !== 'global'
    || !journal.edits.some((edit) => edit.target === 'source-index')
  ) {
    throw new Error('迁移记录不完整。')
  }
  const seenTargets = new Set<string>()
  for (const edit of journal.edits) {
    if (
      !Object.hasOwn(targets, edit.target)
      || seenTargets.has(edit.target)
      || typeof edit.after !== 'string'
      || Buffer.byteLength(edit.after) > 512 * 1024
      || (edit.before !== null && typeof edit.before !== 'string')
    ) {
      throw new Error('迁移目标无效。')
    }
    seenTargets.add(edit.target)
  }
  const globalEdit = journal.edits.find((edit) => edit.target === 'global')
  if (!globalEdit) throw new Error('迁移记录缺少全局画像目标。')
  assertProfileBudget(globalEdit.after)
  return { targets, workspace }
}

function assertUnsharedLegacySource(ctx: AgentMemoryContext, sourcePath: string): void {
  const identity = resolveMemoryPath(sourcePath)
  const aliases = new Set<string>()
  for (const workspace of ctx.workspaces) {
    for (const directory of LEGACY_DIRECTORIES) {
      for (const name of LEGACY_NAMES) {
        const path = join(workspace.root, directory, name)
        if (samePath(path, sourcePath)) continue
        try {
          if (existsSync(path) && resolveMemoryPath(path) === identity) aliases.add(path)
        } catch {
          // 无法解析的别名不阻止迁移，但后续写入会重新校验目标。
        }
      }
    }
  }
  if (aliases.size > 0) {
    throw new Error(
      `多个旧画像入口指向同一文件，当前提案不能同步其他来源索引；未修改任何文件。请先整理共享入口与索引后重新迁移：${[...aliases].join('、')}`,
    )
  }
}

function validateMigrationAliases(
  targets: Record<MemoryMigrationTarget, string>,
  journal: Pick<MemoryMigrationJournal, 'sourcePath' | 'edits'>,
): void {
  const source = resolveMemoryPath(journal.sourcePath)
  const edits = new Map<string, MemoryMigrationEdit>()
  for (const edit of journal.edits) {
    const target = resolveMemoryPath(targets[edit.target])
    if (target === source) {
      throw new Error('迁移源画像与目标指向同一文件，请先调整迁移内容。')
    }
    const previous = edits.get(target)
    if (previous && (previous.before !== edit.before || previous.after !== edit.after)) {
      throw new Error('迁移目标指向同一文件，但合并内容不一致。')
    }
    edits.set(target, edit)
  }
}

function migrationDirectory(ctx: AgentMemoryContext, id: string): string {
  return join(ctx.globalDir, 'migrations', id)
}

export function migrateProfile(ctx: AgentMemoryContext, proposal: MemoryMigrationProposal): string {
  assertProfileMigrationAllowed(ctx)
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const source = discoverLegacyProfiles(ctx, proposal.sourceId)[0]
    if (!source || source.profile.content === null) {
      throw new Error('源画像不存在或不属于已登记工作区。')
    }
    const sourceContext: AgentMemoryContext = { ...ctx, workspaceRoot: source.workspace.root }
    const preferencesPath = memoryPaths(sourceContext).preferences
    const indexPath = memoryPaths(sourceContext).index
    assertProjectMemoryPath(sourceContext, preferencesPath)
    assertProjectMemoryPath(sourceContext, indexPath)
    const globalFile = readGlobalProfile(ctx)
    const preferences = readMemoryFile(preferencesPath)
    const index = readMemoryFile(indexPath)
    for (const [file, revision] of [
      [source.profile, proposal.sourceRevision],
      [globalFile, proposal.globalRevision],
      [preferences, proposal.preferencesRevision],
      [source.index, proposal.sourceIndexRevision],
      [index, proposal.indexRevision],
    ] as const) {
      assertRevision(file, revision)
    }
    if (!proposal.globalContent.trim() || !proposal.rationale.trim()) {
      throw new Error('请提供合并后的全局画像和逐项去重、项目范围、冲突处理依据。')
    }
    assertProfileBudget(proposal.globalContent)
    for (const content of [proposal.sourceIndexContent, proposal.indexContent]) {
      if (!content.trim() || content.toLowerCase().includes(basename(source.profile.path).toLowerCase())) {
        throw new Error('项目索引必须保留其他主题，并移除本次源画像的旧入口；其他待迁移画像的入口暂时保留。')
      }
    }
    if (preferences.content !== null && proposal.preferencesContent === null) {
      throw new Error('已有项目偏好不得在迁移中丢弃。')
    }
    if (
      proposal.preferencesContent !== null
      && (!proposal.preferencesContent.trim() || !proposal.indexContent.includes('project-preferences.md'))
    ) {
      throw new Error('项目补充偏好必须有正文并在项目 MEMORY.md 中建立 project-preferences.md 索引。')
    }
    const sameIndex = resolveMemoryPath(source.index.path) === resolveMemoryPath(index.path)
    if (sameIndex && proposal.sourceIndexContent !== proposal.indexContent) {
      throw new Error('源索引与项目索引为同一文件，内容必须一致。')
    }
    const edits: MemoryMigrationEdit[] = [
      { target: 'global', before: globalFile.content, after: proposal.globalContent },
    ]
    if (proposal.preferencesContent !== null) {
      edits.push({ target: 'preferences', before: preferences.content, after: proposal.preferencesContent })
    }
    edits.push({ target: 'source-index', before: source.index.content, after: proposal.sourceIndexContent })
    if (!sameIndex) edits.push({ target: 'index', before: index.content, after: proposal.indexContent })
    if (edits.some((edit) => Buffer.byteLength(edit.after) > 512 * 1024)) {
      throw new Error('迁移后的单个文件超过 512 KiB，请先按主题整理。')
    }
    const journal: MemoryMigrationJournal = {
      id: randomUUID(),
      sourceId: source.id,
      workspaceRoot: source.workspace.root,
      sourcePath: source.profile.path,
      sourceContent: source.profile.content,
      rationale: proposal.rationale,
      createdAt: Date.now(),
      edits,
    }
    assertUnsharedLegacySource(ctx, journal.sourcePath)
    const { targets } = migrationTargets(ctx, journal)
    validateMigrationAliases(targets, journal)
    const directory = migrationDirectory(ctx, journal.id)
    assertGlobalMemoryPath(ctx, directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeJsonFileAtomic(join(directory, 'pending.json'), journal)
    return applyMigration(ctx, journal)
  })
}

function readJournal(path: string): MemoryMigrationJournal {
  assertJournalFile(path)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isMemoryMigrationJournal(parsed)) throw new Error('迁移记录不完整。')
  return parsed
}

function assertJournalFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_MIGRATION_FILE_BYTES) {
    throw new Error('迁移日志无效或过大。')
  }
}

function isMemoryMigrationJournal(value: unknown): value is MemoryMigrationJournal {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MemoryMigrationJournal>
  return typeof candidate.id === 'string'
    && typeof candidate.sourceId === 'string'
    && typeof candidate.workspaceRoot === 'string'
    && typeof candidate.sourcePath === 'string'
    && typeof candidate.sourceContent === 'string'
    && typeof candidate.rationale === 'string'
    && typeof candidate.createdAt === 'number'
    && Array.isArray(candidate.edits)
}

export function resumeProfileMigration(ctx: AgentMemoryContext, id: string): string {
  assertProfileMigrationAllowed(ctx)
  if (!MIGRATION_ID.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = migrationDirectory(ctx, id)
    const path = join(directory, 'pending.json')
    assertGlobalMemoryPath(ctx, path)
    if (!existsSync(path)) {
      if (existsSync(join(directory, 'completed.json'))) return id
      throw new Error('迁移记录不存在。')
    }
    const journal = readJournal(path)
    if (journal.id !== id) throw new Error('迁移记录与 ID 不一致。')
    return applyMigration(ctx, journal)
  })
}

export function replanProfileMigration(ctx: AgentMemoryContext, id: string): string {
  assertProfileMigrationAllowed(ctx)
  if (!MIGRATION_ID.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = migrationDirectory(ctx, id)
    const path = join(directory, 'pending.json')
    assertGlobalMemoryPath(ctx, path)
    if (!existsSync(path) && existsSync(join(directory, 'superseded.json'))) return id
    const journal = readJournal(path)
    if (journal.id !== id) throw new Error('迁移记录与 ID 不一致。')
    migrationTargets(ctx, journal)
    const source = readMemoryFile(journal.sourcePath)
    if (source.content === null) writeMemoryText(journal.sourcePath, journal.sourceContent)
    renameSync(path, join(directory, 'superseded.json'))
    return id
  })
}

function applyMigration(ctx: AgentMemoryContext, journal: MemoryMigrationJournal): string {
  const { targets, workspace } = migrationTargets(ctx, journal)
  assertUnsharedLegacySource(ctx, journal.sourcePath)
  validateMigrationAliases(targets, journal)
  const sourceContext: AgentMemoryContext = { ...ctx, workspaceRoot: workspace.root }
  const source = readMemoryFile(journal.sourcePath)
  if (source.content !== null && source.content !== journal.sourceContent) {
    throw new Error('源画像已变化，保留待处理迁移和源文件。请使用 replanId 保留新内容后重新合并。')
  }
  for (const edit of journal.edits) {
    if (!Object.hasOwn(targets, edit.target) || typeof edit.after !== 'string') {
      throw new Error('迁移目标无效。')
    }
    const targetPath = targets[edit.target]
    if (edit.target === 'global') {
      assertGlobalMemoryPath(ctx, targetPath)
    } else if (edit.target === 'source-index') {
      assertPathWithinRoot(
        dirname(journal.sourcePath),
        targetPath,
        `源项目索引路径越界，已拒绝写入: ${targetPath}`,
      )
    } else {
      assertProjectMemoryPath(sourceContext, targetPath)
    }
    const content = readMemoryFile(targetPath).content
    if (content !== edit.before && content !== edit.after) {
      throw new Error(`迁移目标存在新改动，未覆盖: ${targetPath}。请使用 MemoryMigrateProfile 的 replanId 保留新改动并重新合并。`)
    }
  }
  const directory = migrationDirectory(ctx, journal.id)
  assertGlobalMemoryPath(ctx, directory)
  const archive = join(directory, 'source-profile.md')
  assertGlobalMemoryPath(ctx, archive)
  writeMemoryText(archive, journal.sourceContent)
  for (const edit of journal.edits) {
    const file = readMemoryFile(targets[edit.target])
    if (file.content === edit.after) continue
    if (file.content !== edit.before) throw new Error('迁移期间出现并发修改，请重新检查。')
    writeMemoryText(file.path, edit.after)
  }
  for (const edit of journal.edits) {
    if (readMemoryFile(targets[edit.target]).content !== edit.after) {
      throw new Error('迁移写后校验失败，保留源文件。')
    }
  }
  const currentSource = readMemoryFile(journal.sourcePath)
  if (currentSource.content !== null) {
    if (currentSource.content !== journal.sourceContent) {
      throw new Error('归档前源画像已变化，保留源文件。')
    }
    rmSync(journal.sourcePath)
  }
  renameSync(join(directory, 'pending.json'), join(directory, 'completed.json'))
  return journal.id
}
