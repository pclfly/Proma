import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'

/**
 * markdown-it 数学公式规则（`$...$` 行内、`$$...$$` 块级）。
 *
 * markdown-it 本身不支持数学语法，而现有 react-markdown 管线依赖 remark-math。
 * 这里按 remark-math 的判定补齐两条规则：同一行内成对的 `$` 视为行内公式
 * （因此 `$5$` 这类文本与旧管线保持一致），整行以 `$$` 起止的内容视为块级公式。
 * 规则挂在 inline 链上、代码段与转义规则之后，`\$` 与代码块不会被误判。
 */

const DOLLAR = 0x24

/** 统计 candidate 之前连续的反斜杠数量，判断分隔符是否被 `\` 转义。 */
function countEscapingBackslashes(source: string, candidate: number, from: number): number {
  let count = 0
  for (let i = candidate - 1; i >= from && source[i] === '\\'; i--) count += 1
  return count
}

/** 行内公式：同一行内成对的 `$` 或 `$$`，不跨换行。 */
function mathInline(state: StateInline, silent: boolean): boolean {
  const source = state.src
  const start = state.pos
  if (source.charCodeAt(start) !== DOLLAR) return false

  const delimiter = source.charCodeAt(start + 1) === DOLLAR ? '$$' : '$'
  const contentStart = start + delimiter.length

  let closeAt = -1
  let searchFrom = contentStart
  while (searchFrom <= state.posMax) {
    const candidate = source.indexOf(delimiter, searchFrom)
    if (candidate === -1) break
    const content = source.slice(searchFrom, candidate)
    if (content.includes('\n')) break
    if (countEscapingBackslashes(source, candidate, contentStart) % 2 === 0) {
      closeAt = candidate
      break
    }
    searchFrom = candidate + 1
  }

  // 未闭合或空公式（`$$`、`$ $` 之外的 `$$`）按普通文本处理，保证原文不丢。
  if (closeAt === -1 || closeAt === contentStart) {
    if (!silent) state.pending += delimiter
    state.pos = contentStart
    return true
  }

  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    // 行内 token 一律标记为 `$`；块级语义只由 block 规则产出。
    token.markup = '$'
    token.content = source.slice(contentStart, closeAt)
  }
  state.pos = closeAt + delimiter.length
  return true
}

/** 块级公式：行首 `$$` 起，到下一个以 `$$` 收尾的行（或同一行的收尾 `$$`）为止。 */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0)
  const max = state.eMarks[startLine] ?? 0
  if (pos + 2 > max) return false
  if (state.src.slice(pos, pos + 2) !== '$$') return false
  if (silent) return true

  let firstLine = state.src.slice(pos + 2, max)
  let lastLine = ''
  let found = false
  if (firstLine.trim().endsWith('$$')) {
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  let next = startLine
  while (!found) {
    next += 1
    if (next >= endLine) break
    const nextStart = state.bMarks[next] ?? 0
    const nextEnd = state.eMarks[next] ?? 0
    const nextPos = nextStart + (state.tShift[next] ?? 0)
    if (nextPos < nextEnd && (state.tShift[next] ?? 0) < state.blkIndent) break
    const line = state.src.slice(nextPos, nextEnd)
    if (line.trim().endsWith('$$')) {
      const closingAt = state.src.slice(0, nextEnd).lastIndexOf('$$')
      lastLine = state.src.slice(nextPos, closingAt)
      found = true
    }
  }

  // 没有闭合分隔符时不接管这一段，交回段落规则，原文按字面量展示。
  if (!found) return false

  state.line = next + 1
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.markup = '$$'
  token.content = (firstLine && firstLine.trim() ? `${firstLine}\n` : '')
    + state.getLines(startLine + 1, next, state.tShift[startLine] ?? 0, true)
    + (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [startLine, state.line]
  return true
}

/** 把数学规则挂到 markdown-it 实例上。 */
export function markdownMathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after('escape', 'math_inline', mathInline)
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
}