import MarkdownIt from 'markdown-it'
import { parseInlineChildren } from './custom-markdown-inline'
import { markdownMathPlugin } from './markdown-math-plugin'
import { getTokenAttr, getTokenStringAttr } from './token-utils'
import type {
  CustomMarkdownParseResult,
  MarkdownAlign,
  MarkdownBlockNode,
  MarkdownHeadingDepth,
  MarkdownInlineNode,
  MarkdownListEntryNode,
  MarkdownTableNode,
  MarkdownTokenLike,
} from './custom-markdown-types'

/**
 * markdown-it token 流 → 虚拟节点。
 *
 * 解析只在明确支持的语法上成功：原始 HTML 按字面量保留；遇到未知 token 或未闭合容器时抛错，
 * 由 parseCustomMarkdown 把整条消息交给 react-markdown 回退，保证内容不丢。
 */

let sharedParser: MarkdownIt | null = null

/** markdown-it 解析器无状态，复用一个实例避免每条消息重建规则链。 */
export function getCustomMarkdownIt(): MarkdownIt {
  if (!sharedParser) {
    sharedParser = new MarkdownIt({ html: false, linkify: false, breaks: true })
    sharedParser.use(markdownMathPlugin)
  }
  return sharedParser
}

interface BlockCursor {
  tokens: readonly MarkdownTokenLike[]
  index: number
}

function peek(cursor: BlockCursor): MarkdownTokenLike {
  const token = cursor.tokens[cursor.index]
  if (!token) throw new Error('Markdown token 流意外结束')
  return token
}

function nextToken(cursor: BlockCursor, expected?: string): MarkdownTokenLike {
  const token = peek(cursor)
  if (expected && token.type !== expected) {
    throw new Error(`期望 ${expected}，实际 ${token.type}`)
  }
  cursor.index += 1
  return token
}

function parseBlocks(cursor: BlockCursor, terminator: string | null): MarkdownBlockNode[] {
  const nodes: MarkdownBlockNode[] = []
  while (cursor.index < cursor.tokens.length) {
    if (terminator && peek(cursor).type === terminator) return nodes
    const node = parseBlockToken(cursor)
    if (node) nodes.push(node)
  }
  if (terminator) throw new Error(`块级标记未闭合: ${terminator}`)
  return nodes
}

/** 围栏信息串只取第一段作为语言，例如 "ts title=x" → "ts" */
function readFenceLanguage(info: string): string | null {
  const language = info.trim().split(/\s+/, 1)[0]
  return language ? language : null
}

const TASK_MARKER_PATTERN = /^\[([ xX])\](?:[ \t]+|$)/

/** 首段以 `[ ]` / `[x]` 开头时升级为任务列表项，并剥离标记。 */
function buildListEntry(children: MarkdownBlockNode[]): MarkdownListEntryNode {
  const first = children[0]
  if (!first || first.type !== 'paragraph') return { type: 'listItem', children }
  const [firstInline, ...restInline] = first.children
  if (!firstInline || firstInline.type !== 'text') return { type: 'listItem', children }

  const match = TASK_MARKER_PATTERN.exec(firstInline.value)
  if (!match) return { type: 'listItem', children }

  const remainder = firstInline.value.slice(match[0].length)
  const inlineChildren: MarkdownInlineNode[] = remainder
    ? [{ type: 'text', value: remainder }, ...restInline]
    : restInline
  return {
    type: 'taskItem',
    checked: match[1] !== ' ',
    children: [{ ...first, children: inlineChildren }, ...children.slice(1)],
  }
}

function parseListItems(cursor: BlockCursor, closeType: string): MarkdownListEntryNode[] {
  const items: MarkdownListEntryNode[] = []
  while (true) {
    const token = peek(cursor)
    if (token.type === closeType) {
      cursor.index += 1
      return items
    }
    if (token.type !== 'list_item_open') {
      throw new Error(`列表中出现了非 list_item token: ${token.type}`)
    }
    cursor.index += 1
    const children = parseBlocks(cursor, 'list_item_close')
    nextToken(cursor, 'list_item_close')
    items.push(buildListEntry(children))
  }
}

function readAlign(token: MarkdownTokenLike): MarkdownAlign {
  const style = getTokenStringAttr(token, 'style') ?? ''
  const match = /text-align:\s*(left|center|right)/.exec(style)
  const align = match?.[1]
  return align === 'left' || align === 'center' || align === 'right' ? align : null
}

function parseTable(cursor: BlockCursor): MarkdownTableNode {
  nextToken(cursor, 'table_open')
  nextToken(cursor, 'thead_open')
  const align: MarkdownAlign[] = []
  const header: MarkdownInlineNode[][] = []
  let firstHeaderRow = true

  while (peek(cursor).type === 'tr_open') {
    nextToken(cursor, 'tr_open')
    while (peek(cursor).type === 'th_open') {
      const open = nextToken(cursor, 'th_open')
      const inline = nextToken(cursor, 'inline')
      nextToken(cursor, 'th_close')
      if (firstHeaderRow) align.push(readAlign(open))
      header.push(parseInlineChildren(inline))
    }
    nextToken(cursor, 'tr_close')
    firstHeaderRow = false
  }
  nextToken(cursor, 'thead_close')

  const rows: MarkdownInlineNode[][][] = []
  if (peek(cursor).type === 'tbody_open') {
    nextToken(cursor, 'tbody_open')
    while (peek(cursor).type === 'tr_open') {
      nextToken(cursor, 'tr_open')
      const row: MarkdownInlineNode[][] = []
      while (peek(cursor).type === 'td_open') {
        nextToken(cursor, 'td_open')
        const inline = nextToken(cursor, 'inline')
        nextToken(cursor, 'td_close')
        row.push(parseInlineChildren(inline))
      }
      nextToken(cursor, 'tr_close')
      rows.push(row)
    }
    nextToken(cursor, 'tbody_close')
  }
  nextToken(cursor, 'table_close')

  return { type: 'table', align, header, rows }
}

function parseList(cursor: BlockCursor, token: MarkdownTokenLike): MarkdownBlockNode {
  const ordered = token.type === 'ordered_list_open'
  const startAttr = getTokenAttr(token, 'start')
  const start = typeof startAttr === 'number' ? startAttr : Number(startAttr ?? 1) || 1
  cursor.index += 1
  const items = parseListItems(cursor, ordered ? 'ordered_list_close' : 'bullet_list_close')
  return { type: 'list', ordered, start: ordered ? start : 1, items }
}

function parseBlockToken(cursor: BlockCursor): MarkdownBlockNode | null {
  const token = peek(cursor)

  switch (token.type) {
    case 'paragraph_open': {
      const tight = token.hidden
      cursor.index += 1
      const inline = nextToken(cursor, 'inline')
      nextToken(cursor, 'paragraph_close')
      return { type: 'paragraph', tight, children: parseInlineChildren(inline) }
    }
    case 'heading_open': {
      const depth = Number(token.tag.slice(1))
      if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
        throw new Error(`未知标题层级: ${token.tag}`)
      }
      cursor.index += 1
      const inline = nextToken(cursor, 'inline')
      nextToken(cursor, 'heading_close')
      return { type: 'heading', depth: depth as MarkdownHeadingDepth, children: parseInlineChildren(inline) }
    }
    case 'blockquote_open': {
      cursor.index += 1
      const children = parseBlocks(cursor, 'blockquote_close')
      nextToken(cursor, 'blockquote_close')
      return { type: 'blockquote', children }
    }
    case 'bullet_list_open':
    case 'ordered_list_open':
      return parseList(cursor, token)
    case 'fence': {
      cursor.index += 1
      return { type: 'codeBlock', value: token.content, language: readFenceLanguage(token.info) }
    }
    case 'code_block': {
      cursor.index += 1
      return { type: 'codeBlock', value: token.content, language: null }
    }
    case 'hr': {
      cursor.index += 1
      return { type: 'thematicBreak' }
    }
    case 'math_block': {
      cursor.index += 1
      return { type: 'math', value: token.content, display: true }
    }
    case 'table_open':
      return parseTable(cursor)
    case 'html_block':
      // react-markdown 未启用 rehype-raw，原始 HTML 一直按字面量展示；
      // 自研管线保持同一行为，不再整条消息回退。
      cursor.index += 1
      return { type: 'paragraph', tight: true, children: [{ type: 'text', value: token.content ?? '' }] }
    default:
      throw new Error(`未知块级 token: ${token.type}`)
  }
}

/** 解析已拿到的 token 流（测试可直接构造最小 token 序列）。 */
export function parseMarkdownTokens(tokens: readonly MarkdownTokenLike[]): MarkdownBlockNode[] {
  const cursor: BlockCursor = { tokens, index: 0 }
  const nodes = parseBlocks(cursor, null)
  if (cursor.index !== tokens.length) throw new Error('存在未消费的 Markdown token')
  return nodes
}

/** Markdown 源文本 → 虚拟节点；失败时返回回退标记，由调用方整条交给 react-markdown。 */
export function parseCustomMarkdown(source: string): CustomMarkdownParseResult {
  if (!source.trim()) return { ok: true, nodes: [] }

  try {
    const tokens = getCustomMarkdownIt().parse(source, {})
    return { ok: true, nodes: parseMarkdownTokens(tokens) }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Markdown 解析失败',
    }
  }
}