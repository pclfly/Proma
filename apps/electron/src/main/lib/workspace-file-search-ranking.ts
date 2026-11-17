/**
 * 工作区文件索引的投影与排序
 *
 * 索引里只保存相对根目录的原始条目；投影时再补上绝对路径与来源（session/workspace），
 * 这样同一个根的索引可以被会话搜索与工作区搜索共享。
 */

import { basename, join } from 'node:path'
import type { FileIndexEntry } from '@proma/shared'
import type { RootScan } from './workspace-file-search-scan'
import { isIgnoredDirectoryName, isIgnoredFileName } from './workspace-file-search-scan'

export type FilePathMode = 'relative' | 'absolute'

/** 匹配等级：文件名前缀 > 文件名包含 > 路径包含 > 文件名模糊子序列 */
const SCORE_PREFIX = 0
const SCORE_NAME = 1
const SCORE_PATH = 2
const SCORE_FUZZY = 3

interface ScoredEntry {
  entry: FileIndexEntry
  score: number
}

/** 把目录索引投影成结果条目；未建立索引（missing）的根返回空数组 */
export function projectDirectoryEntries(
  scan: RootScan,
  pathMode: FilePathMode,
  source: FileIndexEntry['source'],
): FileIndexEntry[] {
  if (scan.kind === 'missing') return []
  if (scan.kind === 'file') {
    const name = basename(scan.root)
    return [{ name, path: pathMode === 'absolute' ? scan.root : name, type: 'file', source }]
  }
  return scan.entries.map((entry) => ({
    name: entry.name,
    path: pathMode === 'absolute' ? join(scan.root, entry.relativePath) : entry.relativePath,
    type: entry.type,
    source,
  }))
}

/** 附加目录/文件：先给出根条目本身，再追加内部条目（与旧实现的分组方式一致） */
export function projectAttachedEntries(scan: RootScan, source: FileIndexEntry['source']): FileIndexEntry[] {
  if (scan.kind === 'missing') return []
  const rootName = basename(scan.root)
  if (isIgnoredFileName(rootName)) return []

  if (scan.kind === 'file') {
    return [{ name: rootName, path: scan.root, type: 'file', source }]
  }
  if (isIgnoredDirectoryName(rootName)) return []

  return [
    { name: rootName === 'workspace-files' ? '项目文件' : rootName, path: scan.root, type: 'dir', source },
    ...projectDirectoryEntries(scan, 'absolute', source),
  ]
}

function isSubsequenceMatch(value: string, query: string): boolean {
  let queryIndex = 0
  for (let index = 0; index < value.length && queryIndex < query.length; index++) {
    if (value[index] === query[queryIndex]) queryIndex += 1
  }
  return queryIndex === query.length
}

function scoreEntry(entry: FileIndexEntry, query: string): number | null {
  const name = entry.name.toLowerCase()
  if (name.startsWith(query)) return SCORE_PREFIX
  if (name.includes(query)) return SCORE_NAME
  if (entry.path.toLowerCase().includes(query)) return SCORE_PATH
  return isSubsequenceMatch(name, query) ? SCORE_FUZZY : null
}

function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  if (a.score !== b.score) return a.score - b.score
  // 文件名命中优先展示文件，目录其次
  if (a.entry.type !== b.entry.type) return a.entry.type === 'file' ? -1 : 1
  if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length
  const byName = a.entry.name.localeCompare(b.entry.name)
  if (byName !== 0) return byName
  return a.entry.path.localeCompare(b.entry.path)
}

/** 大小写不敏感的子串/模糊匹配，前缀命中排最前 */
export function rankMatchedEntries(entries: readonly FileIndexEntry[], query: string): FileIndexEntry[] {
  const scored: ScoredEntry[] = []
  for (const entry of entries) {
    const score = scoreEntry(entry, query)
    if (score === null) continue
    scored.push({ entry, score })
  }
  scored.sort(compareScored)
  return scored.map((item) => item.entry)
}

/** 空查询的浏览模式：目录优先，保证文件夹结构完整可见（与旧实现一致） */
export function sortBrowseEntries(entries: readonly FileIndexEntry[]): FileIndexEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return a.path.localeCompare(b.path)
  })
}