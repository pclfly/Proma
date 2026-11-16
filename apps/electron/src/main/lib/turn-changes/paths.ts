/**
 * 轮次文件改动的路径工具。
 *
 * 只处理纯字符串/路径语义：把 Windows 反斜杠统一为 POSIX、生成相对仓库根
 * 的展示路径，并拒绝越出根目录的目标，避免把会话外文件写进改动记录。
 */

import { isAbsolute, relative, resolve } from 'node:path'

/** 统一为 POSIX 分隔符，供展示与 JSONL 持久化使用。 */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

/** 同一路径的稳定比较键（Windows 大小写不敏感）。 */
export function normalizePathKey(filePath: string): string {
  const normalized = toPosixPath(resolve(filePath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 目标是否位于根目录内（等于根目录也算在内部）。 */
export function isPathInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}

/**
 * 生成相对根目录的 POSIX 路径；越界或根目录本身返回 null。
 * 归一化后仍以 `..` 开头的结果一律视为越界。
 */
export function relativeToRoot(rootPath: string, targetPath: string): string | null {
  if (!isPathInside(rootPath, targetPath)) return null
  const rel = toPosixPath(relative(resolve(rootPath), resolve(targetPath)))
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return null
  return rel
}

/** 把工具输入里的路径解析为绝对路径（相对路径按根目录解析）。 */
export function resolveTargetPath(rootPath: string, targetPath: string): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(rootPath, targetPath)
}

/** 持久化/展示路径是否安全：拒绝绝对路径、盘符与任何 `..` 段。 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false
  const normalized = toPosixPath(relativePath)
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  return normalized
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** 用 POSIX 分隔符拼接展示路径，避免渲染进程依赖 node:path。 */
export function joinDisplayPath(rootPath: string, relativePath: string): string {
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalizedRoot) return normalizedRelative
  return `${normalizedRoot}/${normalizedRelative}`
}
