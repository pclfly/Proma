/**
 * `git diff --numstat -z` 解析。
 *
 * -z 输出以 NUL 分隔，能安全处理含空格/引号的文件名；重命名条目为
 * `add\tdel\t\0old\0new\0`，取新路径作为展示路径。二进制文件的行数字段
 * 为 `-`，统一记为 0 并标记 binary。
 */

import { toPosixPath } from './paths'

export interface GitNumstatEntry {
  filePath: string
  additions: number
  deletions: number
  binary: boolean
}

export function parseGitNumstat(output: string): GitNumstatEntry[] {
  if (!output) return []
  const fields = output.split('\0')
  const entries: GitNumstatEntry[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab <= 0 || secondTab <= firstTab) continue

    const additionsRaw = field.slice(0, firstTab).trim()
    const deletionsRaw = field.slice(firstTab + 1, secondTab).trim()
    let filePath = field.slice(secondTab + 1)
    if (filePath === '') {
      const oldPath = fields[index + 1] ?? ''
      const newPath = fields[index + 2] ?? ''
      index += 2
      filePath = newPath || oldPath
    }
    if (!filePath) continue

    const binary = additionsRaw === '-' || deletionsRaw === '-'
    const additions = binary ? 0 : Number.parseInt(additionsRaw, 10)
    const deletions = binary ? 0 : Number.parseInt(deletionsRaw, 10)
    entries.push({
      filePath: toPosixPath(filePath),
      additions: Number.isFinite(additions) && additions > 0 ? additions : 0,
      deletions: Number.isFinite(deletions) && deletions > 0 ? deletions : 0,
      binary,
    })
  }
  return entries
}
