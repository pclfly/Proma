/**
 * 项目 AGENTS.md 旧规则迁移（官方 0.22.0 记忆子系统）。
 *
 * 与本地 `project-instruction-migration.ts`（CLAUDE.md → AGENTS.md 提示词）区分：
 * 本模块处理工作区根旧 AGENTS.md/AGENTS.MD 与项目根唯一入口的语义合并，
 * 使用 pending/completed/superseded 日志、写后核验和源文件归档。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  readMemoryFile,
  withMemoryLock,
  writeMemoryText,
  type AgentMemoryContext,
  type MemoryFile,
} from './agent-memory'
import { resolveMemoryPath } from './memory-file-path'
import { inspectProjectMap } from './project-map-review'
import { writeJsonFileAtomic } from './safe-file'
import { readInstructionReadyRecord } from './project-instruction-state'

export interface ProjectInstructionMigrationProposal {
  targetRevision: string
  sources: Array<{ path: string; revision: string }>
  content: string
  summary: string
}

export interface InstructionMigrationJournal {
  id: string
  projectRoot: string
  target: MemoryFile
  sources: MemoryFile[]
  content: string
  summary: string
  createdAt: number
}

export interface InstructionMigrationState {
  sources: MemoryFile[]
  issues: Array<{ path: string; message: string }>
  target: MemoryFile
  pendingIds: string[]
  deferred: boolean
  needed: boolean
}

function identity(path: string): string {
  try {
    return resolveMemoryPath(path)
  } catch {
    return resolve(path)
  }
}

function projectInstructionsPath(projectRoot: string): string {
  return inspectProjectMap(projectRoot).path
}

export function inspectLegacyProjectInstructions(ctx: AgentMemoryContext): {
  sources: MemoryFile[]
  issues: Array<{ path: string; message: string }>
} {
  if (readInstructionReadyRecord(ctx)) return { sources: [], issues: [] }

  const target = identity(projectInstructionsPath(ctx.canonicalProjectRoot ?? ctx.projectRoot))
  const seen = new Set([target])
  const sources: MemoryFile[] = []
  const issues: Array<{ path: string; message: string }> = []
  for (const name of ['AGENTS.md', 'AGENTS.MD']) {
    const path = join(ctx.workspaceRoot, name)
    if (seen.has(identity(path))) continue
    seen.add(identity(path))
    try {
      const file = readMemoryFile(path)
      if (file.content !== null) sources.push(file)
    } catch (error) {
      issues.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sources, issues }
}

export function migrationDirectory(ctx: AgentMemoryContext): string {
  return join(ctx.workspaceRoot, 'instruction-migrations')
}

export function pendingInstructionMigrations(ctx: AgentMemoryContext): string[] {
  const directory = migrationDirectory(ctx)
  resolveMemoryPath(directory)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((id) => /^[a-f0-9-]{36}$/.test(id) && existsSync(join(directory, id, 'pending.json')))
}

export function inspectInstructionMigration(ctx: AgentMemoryContext): InstructionMigrationState {
  const { sources, issues } = inspectLegacyProjectInstructions(ctx)
  const target = readMemoryFile(projectInstructionsPath(ctx.projectRoot))
  const pendingIds = pendingInstructionMigrations(ctx)
  const deferred = identity(ctx.projectRoot) !== identity(ctx.canonicalProjectRoot ?? ctx.projectRoot)
  return {
    sources,
    issues,
    target,
    pendingIds,
    deferred,
    needed: sources.length > 0 || pendingIds.length > 0 || issues.length > 0,
  }
}

export function instructionMigrationPrompt(ctx: AgentMemoryContext): string | undefined {
  try {
    if (readInstructionReadyRecord(ctx)) return undefined
    const state = inspectInstructionMigration(ctx)
    if (!state.needed) return undefined
    if (state.issues.length > 0) {
      return `## 项目规则迁移受阻
${state.issues.map((issue) => `${issue.path}：${issue.message}`).join('\n')}
原文件保持不变，不得把异常当作缺失或宣称维护完成。继续本轮正常任务，不反复调用维护工具；仅在需要处理这些规则时说明受阻原因，修复来源后再合并。`
    }
    return `## 项目 AGENTS.md 待统一
唯一项目入口：${state.target.path}。旧外层来源：${state.sources.map((source) => source.path).join('、') || '见未完成迁移记录'}。
${state.deferred
  ? '当前处于 worktree。旧外层规则应在原项目主目录的会话中合并，禁止为了清除提醒修改其他 checkout；当前保留旧规则作为待迁移来源。'
  : `在本轮首次对话（包括问候）中自动维护：先调用 ProjectInstructionsMaintain；需要语义合并时调用 ProjectInstructionsInspect，读取两侧规则，按语义合并、去重，保留有效要求和来源。冲突不能按 mtime 取胜；有证据的用户纠正优先，不确定冲突先询问，解决前不提交迁移。通过 ProjectInstructionsMigrate 提交正文、全部版本与合并依据；工具先保存历史并写后核验，再归档旧文件，禁止手工先删除外层文件。${state.pendingIds.length > 0 ? `未完成迁移：${state.pendingIds.join(', ')}，先用 ProjectInstructionsResume 恢复。` : ''}`}
只读、用户禁止写入或无人在场任务只报告待迁移状态，不迁移。迁移前两份原文都保留；迁移后只以项目根文件为主入口。`
  } catch (error) {
    return `项目规则迁移检查失败，不能当作文件缺失或直接覆盖：${String(error)}`
  }
}

function assertMigrationAllowed(ctx: AgentMemoryContext): void {
  if (ctx.allowInstructionMaintenance === false) throw new Error('当前计划或只读会话不执行项目规则迁移。')
  if (ctx.allowProfileMigration === false) throw new Error('自动化和委派不执行项目规则迁移，请在用户主会话中处理。')
  if (identity(ctx.projectRoot) !== identity(ctx.canonicalProjectRoot ?? ctx.projectRoot)) {
    throw new Error('请在原项目主目录的会话中合并外层规则；不能从 worktree 改写其他 checkout。')
  }
}

export function replanProjectInstructions(ctx: AgentMemoryContext, id: string): string {
  assertMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = join(migrationDirectory(ctx), id)
    const path = join(directory, 'pending.json')
    resolveMemoryPath(path)
    if (!existsSync(path) && existsSync(join(directory, 'superseded.json'))) return id
    if (!lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) throw new Error('规则迁移记录无效。')
    const journal = JSON.parse(readFileSync(path, 'utf8')) as InstructionMigrationJournal
    const allowedSources = ['AGENTS.md', 'AGENTS.MD'].map((name) => join(ctx.workspaceRoot, name))
    if (
      journal.id !== id
      || journal.projectRoot !== identity(ctx.projectRoot)
      || !Array.isArray(journal.sources)
      || journal.sources.some((source) => !allowedSources.includes(source.path) || identity(source.path) === identity(projectInstructionsPath(ctx.projectRoot)))
    ) {
      throw new Error('迁移记录与当前项目不匹配。')
    }
    for (const source of journal.sources) {
      if (readMemoryFile(source.path).content === null) writeMemoryText(source.path, source.content ?? '')
    }
    renameSync(path, join(directory, 'superseded.json'))
    return id
  })
}

export function mergeProjectInstructions(
  ctx: AgentMemoryContext,
  proposal: ProjectInstructionMigrationProposal,
): string {
  assertMigrationAllowed(ctx)
  return withMemoryLock(ctx, () => {
    const state = inspectInstructionMigration(ctx)
    if (state.issues.length > 0) {
      throw new Error(`旧规则无法安全读取，未提交迁移：${state.issues.map((issue) => issue.path).join('、')}`)
    }
    if (state.pendingIds.length > 0) throw new Error(`请先恢复未完成的规则迁移：${state.pendingIds.join(', ')}`)
    if (state.sources.length === 0) throw new Error('没有待合并的外层 AGENTS.md。')
    if (
      state.target.revision !== proposal.targetRevision
      || state.sources.length !== proposal.sources.length
      || state.sources.some((source) => !proposal.sources.some((item) => item.path === source.path && item.revision === source.revision))
    ) {
      throw new Error('项目规则已变化，请重新读取两侧内容并合并。')
    }
    if (!proposal.content.trim() || !proposal.summary.trim()) {
      throw new Error('请提供合并后的有效正文和逐项保留、去重、冲突处理依据。')
    }
    if (Buffer.byteLength(proposal.content) > 512 * 1024) throw new Error('合并后的规则超过 512 KiB，请先按主题整理。')

    const legacyClaude = state.target.content === null
      ? ['CLAUDE.md', 'CLAUDE.MD'].find((name) => existsSync(join(ctx.projectRoot, name)))
      : undefined
    const content = legacyClaude && !proposal.content.includes(`](./${legacyClaude})`)
      ? `${proposal.content.trimEnd()}\n\n请先读取并遵循 [${legacyClaude}](./${legacyClaude}) 中的现有项目规则。\n`
      : proposal.content
    const journal: InstructionMigrationJournal = {
      id: randomUUID(),
      projectRoot: identity(ctx.projectRoot),
      target: state.target,
      sources: state.sources,
      content,
      summary: proposal.summary,
      createdAt: Date.now(),
    }
    const directory = join(migrationDirectory(ctx), journal.id)
    resolveMemoryPath(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeJsonFileAtomic(join(directory, 'pending.json'), journal)
    return applyInstructionMigration(ctx, journal)
  })
}

export function resumeProjectInstructions(ctx: AgentMemoryContext, id: string): string {
  assertMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = join(migrationDirectory(ctx), id)
    const path = join(directory, 'pending.json')
    resolveMemoryPath(path)
    if (!existsSync(path) && existsSync(join(directory, 'completed.json'))) return id
    if (!lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) throw new Error('规则迁移记录无效。')
    const journal = JSON.parse(readFileSync(path, 'utf8')) as InstructionMigrationJournal
    if (journal.id !== id) throw new Error('规则迁移 ID 不一致。')
    return applyInstructionMigration(ctx, journal)
  })
}

function applyInstructionMigration(ctx: AgentMemoryContext, journal: InstructionMigrationJournal): string {
  const allowedTargets = ['AGENTS.md', 'AGENTS.MD'].map((name) => join(ctx.projectRoot, name))
  const allowedSources = ['AGENTS.md', 'AGENTS.MD'].map((name) => join(ctx.workspaceRoot, name))
  if (
    journal.projectRoot !== identity(ctx.projectRoot)
    || !allowedTargets.includes(journal.target.path)
    || journal.sources.length === 0
    || journal.sources.some((file) => !allowedSources.includes(file.path) || identity(file.path) === identity(journal.target.path))
  ) {
    throw new Error('迁移记录与当前项目不匹配，未修改文件。')
  }

  const target = readMemoryFile(journal.target.path)
  if (target.content !== journal.target.content && target.content !== journal.content) {
    throw new Error('项目 AGENTS.md 有新改动，不能用迁移记录覆盖。')
  }
  for (const source of journal.sources) {
    const current = readMemoryFile(source.path)
    if (current.content !== null && current.revision !== source.revision) {
      throw new Error('外层 AGENTS.md 有新改动，保留原文等待重新核对。')
    }
  }

  const directory = join(migrationDirectory(ctx), journal.id)
  for (const [index, source] of journal.sources.entries()) {
    writeMemoryText(join(directory, `source-${index}.md`), source.content ?? '')
  }
  if (journal.target.content !== null) writeMemoryText(join(directory, 'target-before.md'), journal.target.content)
  if (target.content !== journal.content) writeMemoryText(journal.target.path, journal.content)
  if (readMemoryFile(journal.target.path).content !== journal.content) {
    throw new Error('项目规则写后核验失败，保留原文。')
  }
  for (const source of journal.sources) {
    const current = readMemoryFile(source.path)
    if (current.content === null) continue
    if (current.revision !== source.revision) throw new Error('归档前外层规则变化，保留源文件。')
    rmSync(source.path)
  }
  renameSync(join(directory, 'pending.json'), join(directory, 'completed.json'))
  return journal.id
}

export function instructionInspectionRevision(ctx: AgentMemoryContext): string {
  const state = inspectInstructionMigration(ctx)
  return createHash('sha256')
    .update(JSON.stringify({
      target: state.target.revision,
      sources: state.sources.map((file) => [file.path, file.revision]),
    }))
    .digest('hex')
}

export function instructionMaintenancePrompt(ctx: AgentMemoryContext): string | undefined {
  const ready = readInstructionReadyRecord(ctx)
  if (ready) return undefined
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) return undefined
  if (inspectLegacyProjectInstructions(ctx).issues.length > 0) return undefined
  return `## 首次项目能力维护（本轮自动完成）
这是产品已授权的一次性项目基础维护，用户只说 hi、你好或普通问答也触发，不需要用户选择或再次确认是否初始化。
这是后台基础维护，不是用户请求的迁移报告。维护前和工具之间不要输出说明、计划、路径或能力清单；先直接调用 ProjectInstructionsMaintain：工具会保留原文、建立缺少的 AGENTS.md / MEMORY.md / 全局 user_profile.md、关联维护方案，并自动处理空文件或唯一正文的迁移。不要把“建立规则”列为供用户选择的能力，也不要仅回复目录为空。
若返回 needs-merge，使用 ProjectInstructionsInspect 读取双方并调用 ProjectInstructionsMigrate 语义合并；只对无法凭证据解决的实质冲突询问用户。不要为这次基础维护运行全项目调查或为了 200 字编造事实。
完成工具会回读核验并记录持久状态；无需再调用项目规则 Inspect/MemoryInitialize/周检工具验证同一结果；这不限制独立待处理的旧画像整合及其 MemoryInspect/MemoryMigrateProfile。成功后正常回答用户，维护结果只允许在回复末尾附一句“这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用”。用户仅问候时，整条最终回复最多两句；不要列举能做什么，不要说项目目录为空，不要讲 AGENTS/MEMORY、迁移或初始化术语。未成功不能声称已优化。
这条一次性维护优先于普通问答不写知识的通用提示；用户明确只读/禁止写入和无人在场仍不执行。worktree 如有公共旧规则待迁移，保留并延后到原项目会话。`
}
