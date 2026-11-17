/**
 * 工作区文件索引的目录扫描
 *
 * 只用异步 `readdir` 逐层遍历，不同步读取大目录；深度与条目数都有硬上限，
 * 触顶时把 `truncated` 置为 true，让调用方知道索引不完整。
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** 与旧实现的忽略清单保持一致，并补充常见构建/缓存目录 */
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.nuxt',
  'build',
  'out',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
])

const IGNORED_FILE_NAMES = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  'Thumbs.db',
  'desktop.ini',
])

/** 索引条目：相对路径统一使用 `/` 分隔，便于跨平台比较与展示 */
export interface IndexedSearchEntry {
  name: string
  relativePath: string
  type: 'file' | 'dir'
}

export interface RootScan {
  root: string
  /** missing 表示根目录不存在或不可访问，调用方应忽略该根 */
  kind: 'directory' | 'file' | 'missing'
  entries: IndexedSearchEntry[]
  /** 扫描完成时间（ms） */
  scannedAt: number
  /** 是否因深度或条目上限被截断 */
  truncated: boolean
}

export interface WorkspaceFileSearchLimits {
  /** 从根目录（深度 0）起允许深入的最大层级 */
  maxDepth: number
  /** 单个根目录最多收录多少条目 */
  maxEntriesPerRoot: number
}

export type RootScanner = (root: string, limits: WorkspaceFileSearchLimits) => Promise<RootScan>

interface ScanQueueItem {
  dir: string
  relative: string
  depth: number
}

export async function scanDirectoryRoot(root: string, limits: WorkspaceFileSearchLimits): Promise<RootScan> {
  const absoluteRoot = resolve(root)

  let rootStats
  try {
    rootStats = await stat(absoluteRoot)
  } catch {
    return { root: absoluteRoot, kind: 'missing', entries: [], scannedAt: Date.now(), truncated: false }
  }

  if (rootStats.isFile()) {
    return {
      root: absoluteRoot,
      kind: 'file',
      entries: [{ name: basename(absoluteRoot), relativePath: '', type: 'file' }],
      scannedAt: Date.now(),
      truncated: false,
    }
  }
  if (!rootStats.isDirectory()) {
    return { root: absoluteRoot, kind: 'missing', entries: [], scannedAt: Date.now(), truncated: false }
  }

  const entries: IndexedSearchEntry[] = []
  const queue: ScanQueueItem[] = [{ dir: absoluteRoot, relative: '', depth: 0 }]
  let truncated = false

  while (queue.length > 0 && !truncated) {
    const current = queue.shift()
    if (!current) break

    let dirents
    try {
      dirents = await readdir(current.dir, { withFileTypes: true })
    } catch {
      // 无权限或扫描期间被删除的目录直接跳过
      continue
    }

    for (const dirent of dirents) {
      if (IGNORED_FILE_NAMES.has(dirent.name)) continue
      const relativePath = current.relative ? `${current.relative}/${dirent.name}` : dirent.name

      if (dirent.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue
        if (entries.length >= limits.maxEntriesPerRoot) {
          truncated = true
          break
        }
        entries.push({ name: dirent.name, relativePath, type: 'dir' })
        if (current.depth + 1 >= limits.maxDepth) {
          truncated = true
          continue
        }
        queue.push({ dir: join(current.dir, dirent.name), relative: relativePath, depth: current.depth + 1 })
        continue
      }

      if (!dirent.isFile()) continue
      if (entries.length >= limits.maxEntriesPerRoot) {
        truncated = true
        break
      }
      entries.push({ name: dirent.name, relativePath, type: 'file' })
    }
  }

  return { root: absoluteRoot, kind: 'directory', entries, scannedAt: Date.now(), truncated }
}

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name)
}

export function isIgnoredFileName(name: string): boolean {
  return IGNORED_FILE_NAMES.has(name)
}