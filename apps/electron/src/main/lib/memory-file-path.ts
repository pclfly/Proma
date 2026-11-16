/**
 * 记忆文件原子写入。
 *
 * 官方 0.22.0：写入前逐级解析父目录符号链接，拒绝把记忆写到链接目标之外；
 * 目标已存在时必须是普通文件。最终写入复用 safe-file 的原子写。
 */

import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { writeTextFileAtomic } from './safe-file'

/** 解析路径的每一级符号链接；不存在的最末段保持为候选路径。 */
export function resolveMemoryPath(path: string): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent === absolute) return realpathSync.native(absolute)
  const candidate = join(resolveMemoryPath(parent), basename(absolute))
  let entry
  try {
    entry = lstatSync(candidate)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return candidate
    throw error
  }
  if (entry.isSymbolicLink()) {
    try {
      return realpathSync.native(candidate)
    } catch (error) {
      throw new Error(`记忆符号链接目标不可用（失效、循环或不可访问）: ${path}`, { cause: error })
    }
  }
  return realpathSync.native(candidate)
}

export function writeMemoryFileAtomic(path: string, content: string): void {
  const target = resolveMemoryPath(path)
  try {
    if (!statSync(target).isFile()) throw new Error(`记忆目标不是普通文件: ${path}`)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  mkdirSync(dirname(target), { recursive: true })
  writeTextFileAtomic(target, content)
}
