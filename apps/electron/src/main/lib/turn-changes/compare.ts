/**
 * 轮次前后快照比较。
 *
 * 复用 line-diff 的行级 + 词级 hunk 产出，但对二进制、符号链接、超限文件
 * 与超大文本只返回元数据摘要，不做正文 diff。相同签名返回 null，表示本轮
 * 该文件实际没有被改动。
 */

import type { TurnChangeBaselineSource, TurnChangeEntry, TurnChangeHunk, TurnChangeStatus } from '@proma/shared'
import { diffTextLines } from '../line-diff'
import type { CapturedFileSnapshot } from './capture'

/** 超过该体积的文本不进入行级 diff，只给文件大小与状态摘要。 */
export const MAX_DIFF_TEXT_BYTES = 256 * 1024

export interface CompareSnapshotsInput {
  rootPath: string
  filePath: string
  before: CapturedFileSnapshot
  after: CapturedFileSnapshot
  changedAt: number
  baselineSource?: TurnChangeBaselineSource
}

function snapshotText(snapshot: CapturedFileSnapshot): string | null {
  if (snapshot.kind === 'missing') return ''
  if (snapshot.kind === 'text') return snapshot.text ?? ''
  return null
}

function firstMeaningfulLine(lines: string[]): string | undefined {
  return lines.find((line) => line.trim())?.trim().slice(0, 180)
}

function statusOf(before: CapturedFileSnapshot, after: CapturedFileSnapshot): TurnChangeStatus {
  if (before.kind === 'missing') return 'created'
  if (after.kind === 'missing') return 'deleted'
  return 'modified'
}

function toTurnChangeHunk(hunk: ReturnType<typeof diffTextLines>['hunks'][number]): TurnChangeHunk {
  return {
    context: hunk.context,
    removed: hunk.removed.map((line) => ({ line: line.line, text: line.text })),
    added: hunk.added.map((line) => ({ line: line.line, text: line.text })),
  }
}

/** 由前后快照生成单文件改动；签名一致时返回 null。 */
export function compareSnapshots(input: CompareSnapshotsInput): TurnChangeEntry | null {
  const { rootPath, filePath, before, after, changedAt } = input
  if (before.signature === after.signature) return null

  const binary = before.kind === 'binary' || after.kind === 'binary'
  const tooLarge = before.kind === 'too-large' || after.kind === 'too-large'
  const symlink = before.kind === 'symlink' || after.kind === 'symlink'
  const base = {
    filePath,
    rootPath,
    status: statusOf(before, after),
    additions: 0,
    deletions: 0,
    diffAvailable: false,
    truncated: false,
    binary,
    tooLarge,
    symlink,
    baselineSource: input.baselineSource ?? 'file',
    sizeBefore: before.size,
    sizeAfter: after.size,
    updatedAt: changedAt,
  } satisfies TurnChangeEntry

  const beforeText = snapshotText(before)
  const afterText = snapshotText(after)
  if (beforeText === null || afterText === null) return base

  const maxBytes = Math.max(before.size ?? 0, after.size ?? 0)
  if (maxBytes > MAX_DIFF_TEXT_BYTES) {
    // 大文件只给摘要，避免主进程为一次 diff 阻塞数百毫秒。
    return { ...base, truncated: true }
  }

  const result = diffTextLines(beforeText, afterText)
  const hunks = result.hunks.map(toTurnChangeHunk)
  const addedLines = hunks.flatMap((hunk) => hunk.added.map((line) => line.text))
  const removedLines = hunks.flatMap((hunk) => hunk.removed.map((line) => line.text))
  const preview = firstMeaningfulLine(addedLines) ?? firstMeaningfulLine(removedLines)

  return {
    ...base,
    additions: result.addedTotal,
    deletions: result.removedTotal,
    diffAvailable: true,
    truncated: result.truncated,
    ...(preview ? { preview } : {}),
    hunks,
  }
}

/** 汇总一份快照里的行数与文件数，供快照顶层字段使用。 */
export function summarizeEntries(entries: readonly TurnChangeEntry[]): {
  filesChanged: number
  totalAdditions: number
  totalDeletions: number
} {
  return {
    filesChanged: entries.length,
    totalAdditions: entries.reduce((sum, entry) => sum + entry.additions, 0),
    totalDeletions: entries.reduce((sum, entry) => sum + entry.deletions, 0),
  }
}
