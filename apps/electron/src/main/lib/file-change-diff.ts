/**
 * 文件变更快照与 diff 记录。
 *
 * 官方 0.22.0：把“读取快照 → 判断 created/modified/deleted → 生成行级 diff”
 * 收敛为纯函数，供 Agent 文件变更、工作区记忆等监听器复用。
 * 超过 96KB 或二进制文件仍会返回变更记录，但不携带正文 diff。
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { diffTextLines, type TextDiffResult } from './line-diff'

const MAX_DIFF_FILE_BYTES = 96 * 1024

export interface FileChangeSnapshot {
  signature: string
  text?: string
}

export type FileChangeKind = 'created' | 'modified' | 'deleted'

export interface FileChangeRecord {
  relativePath: string
  kind: FileChangeKind
  changedAt: number
  diffAvailable: boolean
  preview?: string
  diff?: TextDiffResult
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 读取普通文件快照；符号链接、超大文件和二进制只返回签名。 */
export function readFileChangeSnapshot(filePath: string): FileChangeSnapshot | undefined {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular file')
    if (stat.size > MAX_DIFF_FILE_BYTES) return { signature: `large:${stat.size}:${stat.mtimeMs}` }
    const raw = readFileSync(filePath)
    if (raw.includes(0)) return { signature: `binary:${sha256(raw)}` }
    return { signature: sha256(raw), text: raw.toString('utf8') }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function firstMeaningfulLine(lines: string[]): string | undefined {
  return lines.find((line) => line.trim())?.trim().slice(0, 180)
}

/** 由前后快照生成变更记录；签名一致时返回 undefined。 */
export function createFileChange(
  relativePath: string,
  before: FileChangeSnapshot | undefined,
  after: FileChangeSnapshot | undefined,
  changedAt: number,
): FileChangeRecord | undefined {
  if (before?.signature === after?.signature) return undefined
  const kind: FileChangeKind = !before ? 'created' : !after ? 'deleted' : 'modified'
  if ((before && before.text === undefined) || (after && after.text === undefined)) {
    return { relativePath, kind, changedAt, diffAvailable: false }
  }

  const { hunks, truncated, removedTotal, addedTotal } = diffTextLines(before?.text ?? '', after?.text ?? '')
  const addedLines = hunks.flatMap((hunk) => hunk.added.map((line) => line.text))
  const removedLines = hunks.flatMap((hunk) => hunk.removed.map((line) => line.text))
  return {
    relativePath,
    kind,
    changedAt,
    diffAvailable: true,
    preview: firstMeaningfulLine(addedLines) ?? firstMeaningfulLine(removedLines),
    diff: { hunks, truncated, removedTotal, addedTotal },
  }
}
