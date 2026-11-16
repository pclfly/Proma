/**
 * 文件树安全删除。
 *
 * 官方 0.22.28：删除文件树条目时不能遍历 reparse points（符号链接 / junction），
 * 否则会顺着链接进入目标目录并误删链接指向的内容。本模块只删除链接本身，
 * 目录递归时逐层 lstat：命中链接立即 unlink，绝不跟随。
 *
 * 设计说明：
 * - 授权根目录本身及其任一父级都不允许是链接；
 * - 待删除路径必须位于授权根内，且根到目标的中间层级不得经过链接；
 * - 目录内的链接只删除链接本身；Windows junction 在 unlink 失败时退化为 rmdir，
 *   同样只移除链接本身，不进入目标；
 * - 单个条目失败不中断整体流程，写入 skipped 返回，由调用方决定如何提示。
 */

import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 递归深度上限，防止异常目录结构导致无限递归。 */
const MAX_TREE_DEPTH = 512

/** 删除流程需要的最小文件系统能力，便于测试注入。 */
export interface TreeEntryStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface TreeDeleteDeps {
  lstat: (target: string) => TreeEntryStat
  readdir: (target: string) => string[]
  unlink: (target: string) => void
  rmdir: (target: string) => void
}

export interface RemoveTreeEntryOptions {
  /** 授权根目录：只允许删除该目录内的条目，且不会删除根目录本身 */
  root: string
  /** 可选的文件系统注入，未提供的项使用 node:fs */
  deps?: Partial<TreeDeleteDeps>
}

export interface RemoveTreeEntryResult {
  /** 目标条目本身是否已被删除 */
  removed: boolean
  /** 因权限、占用、未知类型等原因被跳过的绝对路径 */
  skipped: string[]
}

const defaultDeps: TreeDeleteDeps = {
  lstat: (target) => lstatSync(target),
  readdir: (target) => readdirSync(target),
  unlink: (target) => { unlinkSync(target) },
  rmdir: (target) => { rmdirSync(target) },
}

function safeLstat(deps: TreeDeleteDeps, target: string): TreeEntryStat | null {
  try {
    return deps.lstat(target)
  } catch {
    return null
  }
}

/** readdir 返回的条目名只能是单段；异常名字（含分隔符或 ..）不允许参与拼接。 */
function isSafeEntryName(name: string): boolean {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) return false
  // POSIX 文件名允许反斜杠；Windows 上反斜杠是分隔符，必须拒绝。
  return sep === '/' || !name.includes('\\')
}

/**
 * 删除文件树中的一个条目。
 *
 * @throws 目标为空、超出授权根、目标就是根目录本身、或根/中间层级是链接时抛出；
 *         单个子条目的删除失败不会抛出，而是记录到返回值 skipped。
 */
export function removeTreeEntry(targetPath: string, options: RemoveTreeEntryOptions): RemoveTreeEntryResult {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error('要删除的路径不能为空')
  }
  if (targetPath.includes('\0')) {
    throw new Error('要删除的路径包含非法字符')
  }
  if (!options || typeof options.root !== 'string' || options.root.trim() === '') {
    throw new Error('必须指定授权根目录')
  }
  if (options.root.includes('\0')) {
    throw new Error('授权根目录包含非法字符')
  }

  const deps: TreeDeleteDeps = { ...defaultDeps, ...options.deps }
  const root = resolve(options.root)
  const target = resolve(targetPath)
  const relativePath = relative(root, target)

  if (relativePath === '') {
    throw new Error('不能删除授权根目录本身')
  }
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('要删除的路径超出授权根目录')
  }

  const rootStat = safeLstat(deps, root)
  if (!rootStat) {
    throw new Error('授权根目录不存在或不可访问')
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('授权根目录不安全')
  }

  const parts = relativePath.split(sep).filter((part) => part !== '')
  let current = root
  let targetStat: TreeEntryStat | null = null

  // 逐层 lstat：中间层级是链接就直接拒绝，避免通过链接父级删除根外文件。
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (!part || !isSafeEntryName(part)) {
      throw new Error('要删除的路径包含非法片段')
    }
    current = join(current, part)
    const entryStat = safeLstat(deps, current)
    if (!entryStat) {
      return { removed: false, skipped: [target] }
    }
    if (index === parts.length - 1) {
      targetStat = entryStat
      break
    }
    if (entryStat.isSymbolicLink()) {
      throw new Error('要删除的路径经过链接，已拒绝')
    }
    if (!entryStat.isDirectory()) {
      throw new Error('要删除的路径的父级不是目录')
    }
  }

  const skipped = new Set<string>()

  /** 删除链接本身（unlink）；Windows junction 退化为 rmdir，仍不进入目标。 */
  const removeLink = (entryPath: string): boolean => {
    try {
      deps.unlink(entryPath)
      return true
    } catch {
      try {
        deps.rmdir(entryPath)
        return true
      } catch {
        skipped.add(entryPath)
        return false
      }
    }
  }

  const removeFile = (entryPath: string): boolean => {
    try {
      deps.unlink(entryPath)
      return true
    } catch {
      skipped.add(entryPath)
      return false
    }
  }

  const removeEntry = (entryPath: string, entryStat: TreeEntryStat, depth: number): boolean => {
    if (entryStat.isSymbolicLink()) return removeLink(entryPath)
    if (!entryStat.isDirectory()) return removeFile(entryPath)
    if (depth > MAX_TREE_DEPTH) {
      skipped.add(entryPath)
      return false
    }

    let names: string[]
    try {
      names = deps.readdir(entryPath)
    } catch {
      skipped.add(entryPath)
      return false
    }

    // 排序只为让 skipped 与删除顺序稳定可复现。
    for (const name of names.sort()) {
      const childPath = join(entryPath, name)
      if (!isSafeEntryName(name)) {
        skipped.add(childPath)
        continue
      }
      const childStat = safeLstat(deps, childPath)
      if (!childStat) {
        skipped.add(childPath)
        continue
      }
      removeEntry(childPath, childStat, depth + 1)
    }

    try {
      deps.rmdir(entryPath)
      return true
    } catch {
      // 子项被跳过时目录仍非空，这里记录目录本身并如实返回失败。
      skipped.add(entryPath)
      return false
    }
  }

  const removed = targetStat ? removeEntry(target, targetStat, 0) : false
  return { removed, skipped: [...skipped].sort() }
}
