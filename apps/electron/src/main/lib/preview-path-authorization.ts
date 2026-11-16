/**
 * 内联预览路径授权。
 *
 * 官方 0.22.0：先按显式候选目录解析相对路径，再验证最终 realpath 仍在授权范围内。
 * 绝对路径不再接受候选目录兜底；相对路径默认必须留在最初的候选目录中。
 */

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  isAbsolutePreviewPath,
  resolveFilePath,
} from './file-preview-service'

export interface PreviewPathPolicy {
  candidateBasePaths: readonly string[]
  isExplicitPreviewFile: (path: string) => boolean
  unrestricted: boolean
  /** 允许相对路径超出候选目录落到真实存在的路径；默认关闭。 */
  allowEscapingRelative?: boolean
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function isUnderRoot(resolvedPath: string, root: string): boolean {
  const relativePath = relative(realpathOrResolve(root), resolvedPath)
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath))
}

/** 返回授权后的绝对路径；任一条件不满足返回 null。 */
export function authorizePreviewPath(
  filePath: string,
  policy: PreviewPathPolicy,
): string | null {
  const isAbsoluteInput = isAbsolutePreviewPath(filePath)
  let resolved = resolveFilePath(filePath, [...policy.candidateBasePaths])
  let escapedBase = false
  if (
    !resolved
    && policy.allowEscapingRelative === true
    && !isAbsoluteInput
    && !filePath.includes('\0')
  ) {
    for (const basePath of policy.candidateBasePaths) {
      const candidate = resolve(basePath, filePath)
      if (isExists(candidate)) {
        resolved = candidate
        escapedBase = true
        break
      }
    }
  }
  if (!resolved || !policy.isExplicitPreviewFile(resolved)) return null
  const mustStayWithinCandidateBase = !isAbsoluteInput && !escapedBase
  if (mustStayWithinCandidateBase && !policy.unrestricted) {
    const realResolved = realpathOrResolve(resolved)
    if (!policy.candidateBasePaths.some((basePath) => isUnderRoot(realResolved, basePath))) {
      return null
    }
  }
  return resolved
}

function isExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * 用户主动点击的单文件预览授权。
 *
 * 只放行 realpath 精确匹配的文件本身，不扩散到同目录或祖先目录；
 * 与 unrestricted 的区别是它不能把所在目录整体变成可预览根。
 */
export function isExplicitPreviewFileSelected(
  resolvedPath: string,
  explicitPreviewFiles?: readonly string[],
): boolean {
  if (!explicitPreviewFiles || explicitPreviewFiles.length === 0) return false
  return explicitPreviewFiles.some((file) => realpathOrResolve(file) === resolvedPath)
}
