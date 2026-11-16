/**
 * 文本 diff 核心。
 *
 * 官方 0.22.0 将文件变更展示从简单前后缀比较升级为：
 * - 行级 LCS（带最大单元格保护，超大文件退化为全删全增）
 * - 变更块合并（相邻 hunk 在 1 行上下文内合并）
 * - 词级 diff（同一位置的删/增行按 token 对齐，支持 CJK 单字切分）
 *
 * 输出为稳定的纯数据，便于主进程/渲染进程复用与测试。
 */

export interface DiffSpan {
  start: number
  end: number
}

export interface DiffLine {
  line: number
  text: string
}

export interface DiffHunk {
  context: string[]
  removed: DiffLine[]
  added: DiffLine[]
  wordSpans?: {
    removed: Array<DiffSpan[] | null>
    added: Array<DiffSpan[] | null>
  }
}

export interface TextDiffResult {
  hunks: DiffHunk[]
  truncated: boolean
  removedTotal: number
  addedTotal: number
}

export interface WordDiffResult {
  removed: DiffSpan[]
  added: DiffSpan[]
}

interface DiffOp {
  type: 'equal' | 'removed' | 'added'
  beforeLine?: number
  afterLine?: number
  text: string
}

interface Token {
  text: string
  start: number
  end: number
}

const MAX_CHANGE_LINES_PER_SIDE = 8
const MAX_CHANGE_HUNKS = 3
const MAX_CHANGE_CONTEXT_LINES = 1
const MAX_WORD_DIFF_LINES = 4
const MAX_WORD_DIFF_LINE_LENGTH = 400
const MAX_LCS_CELLS = 1_000_000
const WORD_TOKEN = /[\p{L}\p{N}_]/u
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

function cell(dp: Uint32Array, index: number): number {
  return dp[index] ?? 0
}

function stripTrailingEmpty(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end -= 1
  return end === lines.length ? lines : lines.slice(0, end)
}

function computeOps(before: string[], after: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    ops.push({ type: 'equal', beforeLine: prefix + 1, afterLine: prefix + 1, text: before[prefix] ?? '' })
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1
  }

  const middleBefore = before.slice(prefix, before.length - suffix)
  const middleAfter = after.slice(prefix, after.length - suffix)

  if (middleBefore.length > 0 || middleAfter.length > 0) {
    const rows = middleBefore.length + 1
    const cols = middleAfter.length + 1
    if (rows * cols > MAX_LCS_CELLS) {
      // 超大变更不做 LCS，直接全删全增，保证主进程响应时间。
      for (let i = 0; i < middleBefore.length; i += 1) {
        ops.push({ type: 'removed', beforeLine: prefix + i + 1, text: middleBefore[i] ?? '' })
      }
      for (let j = 0; j < middleAfter.length; j += 1) {
        ops.push({ type: 'added', afterLine: prefix + j + 1, text: middleAfter[j] ?? '' })
      }
    } else {
      const dp = new Uint32Array(rows * cols)
      for (let i = middleBefore.length - 1; i >= 0; i -= 1) {
        for (let j = middleAfter.length - 1; j >= 0; j -= 1) {
          dp[i * cols + j] = middleBefore[i] === middleAfter[j]
            ? cell(dp, (i + 1) * cols + (j + 1)) + 1
            : Math.max(cell(dp, (i + 1) * cols + j), cell(dp, i * cols + (j + 1)))
        }
      }

      let i = 0
      let j = 0
      while (i < middleBefore.length && j < middleAfter.length) {
        if (middleBefore[i] === middleAfter[j]) {
          ops.push({ type: 'equal', beforeLine: prefix + i + 1, afterLine: prefix + j + 1, text: middleBefore[i] ?? '' })
          i += 1
          j += 1
        } else if (cell(dp, (i + 1) * cols + j) >= cell(dp, i * cols + (j + 1))) {
          ops.push({ type: 'removed', beforeLine: prefix + i + 1, text: middleBefore[i] ?? '' })
          i += 1
        } else {
          ops.push({ type: 'added', afterLine: prefix + j + 1, text: middleAfter[j] ?? '' })
          j += 1
        }
      }
      while (i < middleBefore.length) {
        ops.push({ type: 'removed', beforeLine: prefix + i + 1, text: middleBefore[i] ?? '' })
        i += 1
      }
      while (j < middleAfter.length) {
        ops.push({ type: 'added', afterLine: prefix + j + 1, text: middleAfter[j] ?? '' })
        j += 1
      }
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    ops.push({
      type: 'equal',
      beforeLine: before.length - suffix + k + 1,
      afterLine: after.length - suffix + k + 1,
      text: before[before.length - suffix + k] ?? '',
    })
  }
  return ops
}

function groupHunks(ops: DiffOp[]): DiffOp[][] {
  const regions: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < ops.length) {
    if (ops[index]?.type === 'equal') {
      index += 1
      continue
    }
    const start = index
    while (index < ops.length && ops[index]?.type !== 'equal') index += 1
    regions.push({ start, end: index })
  }

  const merged: Array<{ start: number; end: number }> = []
  for (const region of regions) {
    const previous = merged[merged.length - 1]
    if (previous && region.start - previous.end <= MAX_CHANGE_CONTEXT_LINES) previous.end = region.end
    else merged.push({ ...region })
  }
  return merged.map((region) => ops.slice(region.start, region.end))
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (CJK_CHAR.test(char)) {
      tokens.push({ text: char, start: index, end: index + 1 })
      index += 1
      continue
    }
    if (WORD_TOKEN.test(char)) {
      let end = index + 1
      while (end < text.length && WORD_TOKEN.test(text[end] ?? '') && !CJK_CHAR.test(text[end] ?? '')) end += 1
      tokens.push({ text: text.slice(index, end), start: index, end })
      index = end
      continue
    }
    tokens.push({ text: char, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
  if (spans.length === 0) return spans
  const sorted = [...spans].sort((left, right) => left.start - right.start)
  const first = sorted[0]
  if (!first) return []
  const merged: DiffSpan[] = [{ ...first }]
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (!last) continue
    if (span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/** 同一行内的词级 diff；超过 LCS 上限时返回空 spans。 */
export function diffWordsInLine(before: string, after: string): WordDiffResult {
  const beforeTokens = tokenize(before)
  const afterTokens = tokenize(after)
  const rows = beforeTokens.length + 1
  const cols = afterTokens.length + 1
  if (rows * cols > MAX_LCS_CELLS) return { removed: [], added: [] }

  const dp = new Uint32Array(rows * cols)
  for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
    for (let j = afterTokens.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = beforeTokens[i]?.text === afterTokens[j]?.text
        ? cell(dp, (i + 1) * cols + (j + 1)) + 1
        : Math.max(cell(dp, (i + 1) * cols + j), cell(dp, i * cols + (j + 1)))
    }
  }

  const removed: DiffSpan[] = []
  const added: DiffSpan[] = []
  let i = 0
  let j = 0
  while (i < beforeTokens.length && j < afterTokens.length) {
    const beforeToken = beforeTokens[i]
    const afterToken = afterTokens[j]
    if (!beforeToken || !afterToken) break
    if (beforeToken.text === afterToken.text) {
      i += 1
      j += 1
    } else if (cell(dp, (i + 1) * cols + j) >= cell(dp, i * cols + (j + 1))) {
      removed.push({ start: beforeToken.start, end: beforeToken.end })
      i += 1
    } else {
      added.push({ start: afterToken.start, end: afterToken.end })
      j += 1
    }
  }
  while (i < beforeTokens.length) {
    const token = beforeTokens[i]
    if (token) removed.push({ start: token.start, end: token.end })
    i += 1
  }
  while (j < afterTokens.length) {
    const token = afterTokens[j]
    if (token) added.push({ start: token.start, end: token.end })
    j += 1
  }
  return { removed: mergeSpans(removed), added: mergeSpans(added) }
}

function blockPrefixLength(line: string): number {
  const match = /^(\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*|\|?\s*[-:|\s]+\|?\s*))/.exec(line)
  return match ? match[1]?.length ?? 0 : /^\s*/.exec(line)?.[0].length ?? 0
}

function buildWordSpans(
  removedLines: string[],
  addedLines: string[],
): Pick<DiffHunk, 'wordSpans'> {
  const pairCount = Math.min(removedLines.length, addedLines.length)
  if (removedLines.length !== addedLines.length || pairCount === 0 || pairCount > MAX_WORD_DIFF_LINES) return {}

  const removed: Array<DiffSpan[] | null> = []
  const added: Array<DiffSpan[] | null> = []
  for (let index = 0; index < pairCount; index += 1) {
    const beforeLine = removedLines[index] ?? ''
    const afterLine = addedLines[index] ?? ''
    if (beforeLine.length > MAX_WORD_DIFF_LINE_LENGTH || afterLine.length > MAX_WORD_DIFF_LINE_LENGTH) {
      removed.push(null)
      added.push(null)
      continue
    }
    const spans = diffWordsInLine(beforeLine, afterLine)
    const clamp = (line: string, list: DiffSpan[]): DiffSpan[] => {
      const limit = blockPrefixLength(line)
      return list
        .map((span) => ({ start: Math.max(span.start, limit), end: span.end }))
        .filter((span) => span.end > span.start)
    }
    const removedSpans = clamp(beforeLine, spans.removed)
    const addedSpans = clamp(afterLine, spans.added)
    removed.push(removedSpans.length > 0 ? removedSpans : null)
    added.push(addedSpans.length > 0 ? addedSpans : null)
  }
  return { wordSpans: { removed, added } }
}

function collectContext(before: string[], removedOps: DiffOp[], addedOps: DiffOp[]): string[] {
  const firstBeforeLine = removedOps[0]?.beforeLine
  const firstAfterLine = addedOps[0]?.afterLine
  const anchorLine = (firstBeforeLine ?? firstAfterLine ?? 1) - 1
  if (anchorLine <= 0) return []
  const lines: string[] = []
  for (let offset = MAX_CHANGE_CONTEXT_LINES; offset >= 1; offset -= 1) {
    const line = anchorLine - offset + 1
    if (line >= 1 && line <= before.length) lines.push(before[line - 1] ?? '')
  }
  return lines
}

/** 文本行级 diff，输出最多 3 个 hunk，每个方向最多 8 行。 */
export function diffTextLines(beforeText: string, afterText: string): TextDiffResult {
  const before = stripTrailingEmpty(beforeText.split(/\r?\n/))
  const after = stripTrailingEmpty(afterText.split(/\r?\n/))
  const groups = groupHunks(computeOps(before, after))
  let removedTotal = 0
  let addedTotal = 0
  const hunks: DiffHunk[] = []
  let truncated = false

  for (const group of groups) {
    const removedOps = group.filter((op) => op.type === 'removed')
    const addedOps = group.filter((op) => op.type === 'added')
    removedTotal += removedOps.length
    addedTotal += addedOps.length
    if (hunks.length >= MAX_CHANGE_HUNKS) {
      truncated = true
      continue
    }
    const context = collectContext(before, removedOps, addedOps)
    const removedSlice = removedOps.slice(0, MAX_CHANGE_LINES_PER_SIDE)
    const addedSlice = addedOps.slice(0, MAX_CHANGE_LINES_PER_SIDE)
    if (removedSlice.length < removedOps.length || addedSlice.length < addedOps.length) truncated = true
    hunks.push({
      context,
      removed: removedSlice.map((op) => ({ line: op.beforeLine ?? 0, text: op.text })),
      added: addedSlice.map((op) => ({ line: op.afterLine ?? 0, text: op.text })),
      ...buildWordSpans(removedSlice.map((op) => op.text), addedSlice.map((op) => op.text)),
    })
  }
  if (groups.length > hunks.length) truncated = true
  return { hunks, truncated, removedTotal, addedTotal }
}
