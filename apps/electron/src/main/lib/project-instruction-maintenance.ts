/**
 * 项目能力维护（官方 0.22.0）。
 *
 * 首次进入可写项目会话时建立/关联 AGENTS.md、MEMORY.md、全局 Profile；
 * 旧外层 AGENTS.md 只有一方非空或内容一致时自动合并，多份实质冲突返回
 * needs-merge 交给 ProjectInstructionsInspect/Migrate。
 */

import {
  ensureMemoryFiles,
  hasMemoryAssociation,
  linkProjectMemory,
  memoryPaths,
  readMemoryFile,
  withMemoryLock,
  type AgentMemoryContext,
} from './agent-memory'
import {
  inspectInstructionMigration,
  instructionMigrationPrompt,
  mergeProjectInstructions,
  resumeProjectInstructions,
} from './project-instruction-memory-migration'
import {
  readInstructionReadyRecord,
  writeInstructionReadyRecord,
} from './project-instruction-state'

function assertWritable(ctx: AgentMemoryContext): void {
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) {
    throw new Error('当前只读、计划或无人值守会话不执行项目能力维护。')
  }
}

export interface ProjectInstructionMaintenanceResult {
  status: 'ready' | 'blocked' | 'deferred' | 'needs-merge'
  changed: boolean
  targetPath?: string
  completedAt?: number
  sources?: Array<{ path: string; revision: string }>
  pendingIds?: string[]
  issues?: Array<{ path: string; message: string }>
}

export function finishInstructionMaintenance(
  ctx: AgentMemoryContext,
  changed = true,
): ReturnType<typeof writeInstructionReadyRecord> {
  assertWritable(ctx)
  ensureMemoryFiles(ctx)
  return withMemoryLock(ctx, () => {
    const state = inspectInstructionMigration(ctx)
    if (state.needed) throw new Error('旧项目规则尚未合并，不能记录项目能力维护完成。')
    linkProjectMemory(ctx)
    const target = readMemoryFile(state.target.path)
    if (!hasMemoryAssociation(ctx, target.content ?? '')) throw new Error('项目规则记忆关联未就绪。')
    return writeInstructionReadyRecord(ctx, target.path, changed)
  })
}

export function maintainProjectInstructions(ctx: AgentMemoryContext): ProjectInstructionMaintenanceResult {
  assertWritable(ctx)
  const ready = readInstructionReadyRecord(ctx)
  if (ready) return { status: 'ready', changed: false, targetPath: ready.targetPath, completedAt: ready.completedAt }

  let state = inspectInstructionMigration(ctx)
  if (state.issues.length > 0) {
    return { status: 'blocked', changed: false, sources: state.sources, pendingIds: state.pendingIds, issues: state.issues }
  }
  if (state.deferred && state.needed) {
    return { status: 'deferred', changed: false, sources: state.sources, pendingIds: state.pendingIds, issues: state.issues }
  }
  for (const id of state.pendingIds) resumeProjectInstructions(ctx, id)
  state = inspectInstructionMigration(ctx)

  const contents = [...new Set([state.target, ...state.sources].map((file) => file.content?.trim()).filter((value): value is string => Boolean(value)))]
  if (state.sources.length > 0 && contents.length > 1) {
    return { status: 'needs-merge', changed: false, targetPath: state.target.path, sources: state.sources, pendingIds: state.pendingIds, issues: state.issues }
  }

  const paths = memoryPaths(ctx)
  const changed = state.sources.length > 0
    || !hasMemoryAssociation(ctx, state.target.content ?? '')
    || !readMemoryFile(paths.index).content?.trim()
    || !readMemoryFile(paths.profile).content?.trim()

  if (state.sources.length > 0) {
    mergeProjectInstructions(ctx, {
      targetRevision: state.target.revision,
      sources: state.sources.map((file) => ({ path: file.path, revision: file.revision })),
      content: contents[0] ?? '# 项目约定\n\n项目事实随实际任务按已核验信息补充，不编造项目架构、命令或用户偏好。',
      summary: '首次能力维护：保留唯一非空正文或去重相同正文；无规则冲突。空文件仅建立真实的基础说明。',
    })
  }

  const record = finishInstructionMaintenance(ctx, changed)
  return { status: 'ready', changed, targetPath: record.targetPath, completedAt: record.completedAt }
}

export { instructionMigrationPrompt, instructionMaintenancePrompt } from './project-instruction-memory-migration'
