/**
 * 项目规则维护完成记录。
 *
 * 官方 0.22.0：首次项目能力维护完成后写入 `{workspaceRoot}/instruction-maintenance/<hash>.json`，
 * 只有目标 AGENTS.md 的 inode/size/mtime/ctime 与 Profile/MEMORY.md 均未变化时才视为有效，
 * 避免重复迁移或用旧状态覆盖新规则。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { memoryPaths, type AgentMemoryContext } from './agent-memory'
import { resolveMemoryPath } from './memory-file-path'
import { writeJsonFileAtomic } from './safe-file'

export interface InstructionReadyRecord {
  version: 1
  projectRoot: string
  globalDir: string
  targetPath: string
  targetStamp: string
  completedAt: number
  changed: boolean
}

function instructionPathIdentity(path: string): string {
  try {
    return resolveMemoryPath(path)
  } catch {
    return resolve(path)
  }
}

function recordPath(ctx: AgentMemoryContext): string {
  const key = createHash('sha256').update(instructionPathIdentity(ctx.projectRoot)).digest('hex')
  return join(ctx.workspaceRoot, 'instruction-maintenance', `${key}.json`)
}

function stamp(path: string): string | undefined {
  try {
    const stat = lstatSync(resolveMemoryPath(path))
    if (!stat.isFile() || stat.size === 0) return undefined
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export function readInstructionReadyRecord(ctx: AgentMemoryContext): InstructionReadyRecord | undefined {
  const path = recordPath(ctx)
  try {
    const resolved = resolveMemoryPath(path)
    if (!existsSync(resolved)) return undefined
    if (lstatSync(resolved).size > 16_384) return undefined
    const record = JSON.parse(readFileSync(resolved, 'utf8')) as Partial<InstructionReadyRecord>
    const targetPath = record.targetPath
    if (typeof targetPath !== 'string') return undefined
    if (
      record.version !== 1
      || typeof record.completedAt !== 'number'
      || !Number.isFinite(record.completedAt)
      || record.completedAt <= 0
      || record.completedAt > Date.now()
      || record.projectRoot !== instructionPathIdentity(ctx.projectRoot)
      || record.globalDir !== instructionPathIdentity(ctx.globalDir)
      || !['AGENTS.md', 'AGENTS.MD'].some((name) => targetPath === join(ctx.projectRoot, name))
      || record.targetStamp !== stamp(targetPath)
    ) {
      return undefined
    }
    if (targetPath.endsWith('AGENTS.MD') && existsSync(join(ctx.projectRoot, 'AGENTS.md'))) return undefined

    const canonical = instructionPathIdentity(ctx.canonicalProjectRoot ?? ctx.projectRoot)
    for (const name of ['AGENTS.md', 'AGENTS.MD']) {
      const source = join(ctx.workspaceRoot, name)
      if (instructionPathIdentity(ctx.workspaceRoot) !== canonical) {
        try {
          lstatSync(source)
          return undefined
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    }

    const paths = memoryPaths(ctx)
    if (!stamp(paths.profile) || !stamp(paths.index)) return undefined
    return record as InstructionReadyRecord
  } catch {
    return undefined
  }
}

export function writeInstructionReadyRecord(
  ctx: AgentMemoryContext,
  targetPath: string,
  changed: boolean,
): InstructionReadyRecord {
  const existing = readInstructionReadyRecord(ctx)
  if (existing && !changed) return existing

  const targetStamp = stamp(targetPath)
  const paths = memoryPaths(ctx)
  if (!targetStamp || !stamp(paths.profile) || !stamp(paths.index)) {
    throw new Error('项目规则或必需记忆尚未就绪，不能记录完成。')
  }

  const record: InstructionReadyRecord = {
    version: 1,
    projectRoot: instructionPathIdentity(ctx.projectRoot),
    globalDir: instructionPathIdentity(ctx.globalDir),
    targetPath,
    targetStamp,
    completedAt: Date.now(),
    changed,
  }
  const path = recordPath(ctx)
  resolveMemoryPath(path)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}
