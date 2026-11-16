import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { KnowledgeFileWitness } from './knowledge-mutation-protocol'

export const MAX_KNOWLEDGE_WITNESS_BYTES = 96 * 1024

export interface KnowledgeWitnessSnapshot {
  witness: KnowledgeFileWitness
  text?: string
}

function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/** 不存在的文件用最近已存在祖先的真实路径推导，避免把链接目标误判成新文件。 */
export function resolvePhysicalPath(filePath: string): string {
  let probe = filePath
  const missing: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = lstatSync(probe)
      // 目标本身是链接时不跟随：调用者必须先证明它位于授权根内。
      if (missing.length === 0 && stat.isSymbolicLink()) return filePath
      const real = realpathSync(probe)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) return filePath
      missing.push(basename(probe))
      probe = parent
    }
  }
  return filePath
}

/**
 * 只读生成一个受限文件见证。错误分支必须显式区分 missing 与 unsupported：
 * 权限/链接/超大/二进制都不能被当作“文件不存在”，否则会把别人的改动归给本次写入。
 */
export function readKnowledgeWitness(filePath: string, maxBytes = MAX_KNOWLEDGE_WITNESS_BYTES): KnowledgeWitnessSnapshot {
  const physicalPath = resolvePhysicalPath(filePath)
  let stat
  try {
    stat = lstatSync(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { witness: { state: 'missing', physicalPath } }
    return { witness: { state: 'unsupported', physicalPath } }
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    return { witness: { state: 'unsupported', physicalPath } }
  }
  try {
    const raw = readFileSync(filePath)
    if (raw.includes(0) || raw.length > maxBytes) return { witness: { state: 'unsupported', physicalPath } }
    return {
      witness: {
        state: 'text',
        physicalPath,
        sha256: sha256(raw),
        byteLength: raw.length,
        version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      },
      text: raw.toString('utf8'),
    }
  } catch {
    return { witness: { state: 'unsupported', physicalPath } }
  }
}

export interface KnowledgePathInspection {
  state: 'missing' | 'file' | 'unsupported'
  physicalPath: string
}

/** 只做路径与类型判定，不读文件内容；用于给每个 typed 写入做低成本分类。 */
export function inspectKnowledgePath(filePath: string): KnowledgePathInspection {
  const physicalPath = resolvePhysicalPath(filePath)
  try {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'unsupported', physicalPath }
    return { state: 'file', physicalPath }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'missing', physicalPath }
    return { state: 'unsupported', physicalPath }
  }
}
