/**
 * Obsidian Callout 的阅读态解析与正文渲染。
 *
 * 只负责“识别与生成 HTML”，不改写源码。块级替换由 LiveMarkdownPreview 在
 * 选区不在该块内时启用；光标进入块后自动回到原始 Markdown 编辑。
 */
import MarkdownIt from 'markdown-it'
import { installInlineVaultWikiLinks } from './live-markdown-wikilink-inline'

/** `> [!note]- 标题`；`+` 默认展开，`-` 默认折叠，无标记为不可折叠。 */
const CALLOUT_START = /^ {0,3}>\s*\[!([A-Za-z][\w-]*)\]([+-])?[ \t]*(.*)$/
const BLOCKQUOTE_LINE = /^ {0,3}>/
const QUOTE_PREFIX = /^ {0,3}>\s?/

export type LiveMarkdownCalloutKind =
  | 'note' | 'tip' | 'important' | 'warning' | 'danger' | 'question' | 'quote' | 'example' | 'success'

export interface LiveMarkdownCallout {
  /** 原始类型名称，保留用户写法。 */
  type: string
  kind: LiveMarkdownCalloutKind
  title: string
  fold: 'open' | 'closed' | null
  body: string
}

const KIND_BY_TYPE: Record<string, LiveMarkdownCalloutKind> = {
  note: 'note', info: 'note',
  tip: 'tip', hint: 'tip', abstract: 'tip', summary: 'tip', todo: 'tip',
  important: 'important',
  warning: 'warning', caution: 'warning', attention: 'warning',
  danger: 'danger', error: 'danger', failure: 'danger', fail: 'danger', missing: 'danger', bug: 'danger',
  question: 'question', help: 'question', faq: 'question',
  quote: 'quote', cite: 'quote',
  example: 'example',
  success: 'success', check: 'success', done: 'success',
}

const DEFAULT_TITLES: Record<LiveMarkdownCalloutKind, string> = {
  note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', danger: 'Danger',
  question: 'Question', quote: 'Quote', example: 'Example', success: 'Success',
}

export function isLiveMarkdownCalloutStart(line: string): boolean {
  return CALLOUT_START.test(line)
}

export function isLiveMarkdownBlockquoteLine(line: string): boolean {
  return BLOCKQUOTE_LINE.test(line)
}

/** 解析完整 Callout 块；任何一行不是引用则不是有效 Callout，保持原文。 */
export function parseLiveMarkdownCallout(source: string): LiveMarkdownCallout | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const first = lines[0]
  if (first === undefined) return null
  const match = first.match(CALLOUT_START)
  if (!match) return null
  if (lines.some((line) => !BLOCKQUOTE_LINE.test(line))) return null
  const type = match[1]!
  const kind = KIND_BY_TYPE[type.toLowerCase()] ?? 'note'
  const customTitle = (match[3] ?? '').trim()
  return {
    type,
    kind,
    title: customTitle || DEFAULT_TITLES[kind],
    fold: match[2] === '+' ? 'open' : match[2] === '-' ? 'closed' : null,
    body: lines
      .slice(1)
      .map((line) => line.replace(QUOTE_PREFIX, ''))
      .join('\n')
      .replace(/\s+$/, ''),
  }
}

const bodyMarkdown = new MarkdownIt({ html: false, breaks: true, linkify: false })
installInlineVaultWikiLinks(bodyMarkdown)

/** 正文只渲染安全 HTML（不执行原始 HTML）；Vault 中可选启用双链。 */
export function renderLiveMarkdownCalloutBody(
  body: string,
  options: { vaultWikiLinks?: boolean } = {},
): string {
  if (!body.trim()) return ''
  return bodyMarkdown.render(body, { vaultWikiLinks: options.vaultWikiLinks === true })
}
