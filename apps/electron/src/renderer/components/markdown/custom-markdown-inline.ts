import type { MarkdownInlineNode, MarkdownTokenLike } from './custom-markdown-types'
import { splitMentionText } from './mention-tokens'
import { getTokenStringAttr } from './token-utils'

/**
 * markdown-it 行内 token → 虚拟节点。
 *
 * 只接受已知 token；原始 HTML 按字面量展示（与 react-markdown 未启用
 * rehype-raw 一致），未知类型抛错后由上层整条回退。
 */

interface InlineCursor {
  tokens: readonly MarkdownTokenLike[]
  index: number
}

/** 文本 token 内联 mention 切分：mention 走链接节点，复用 MarkdownLink 的 chip 渲染。 */
function pushTextNodes(nodes: MarkdownInlineNode[], value: string): void {
  if (!value) return
  for (const segment of splitMentionText(value)) {
    if (segment.type === 'text') {
      if (segment.value) nodes.push({ type: 'text', value: segment.value })
    } else {
      nodes.push({
        type: 'link',
        href: segment.href,
        children: [{ type: 'text', value: segment.text }],
      })
    }
  }
}

/** 消费一个成对的行内容器（strong / em / del / a），返回其子节点。 */
function parseContainer(cursor: InlineCursor, closeType: string): MarkdownInlineNode[] {
  const children = parseInlineNodes(cursor, closeType)
  const close = cursor.tokens[cursor.index]
  if (!close || close.type !== closeType) {
    throw new Error(`行内标记未闭合: ${closeType}`)
  }
  cursor.index += 1
  return children
}

function parseInlineNodes(cursor: InlineCursor, terminator: string | null): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = []

  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index]!
    if (terminator && token.type === terminator) return nodes

    switch (token.type) {
      case 'text':
      case 'text_special': {
        pushTextNodes(nodes, token.content)
        cursor.index += 1
        break
      }
      case 'softbreak':
      case 'hardbreak': {
        // breaks: true 时软换行与硬换行都按 <br> 渲染，与现有“保留换行”一致。
        nodes.push({ type: 'break' })
        cursor.index += 1
        break
      }
      case 'code_inline': {
        nodes.push({ type: 'inlineCode', value: token.content })
        cursor.index += 1
        break
      }
      case 'strong_open': {
        cursor.index += 1
        nodes.push({ type: 'strong', children: parseContainer(cursor, 'strong_close') })
        break
      }
      case 'em_open': {
        cursor.index += 1
        nodes.push({ type: 'emphasis', children: parseContainer(cursor, 'em_close') })
        break
      }
      case 's_open': {
        cursor.index += 1
        nodes.push({ type: 'delete', children: parseContainer(cursor, 's_close') })
        break
      }
      case 'link_open': {
        const href = getTokenStringAttr(token, 'href') ?? ''
        const title = getTokenStringAttr(token, 'title')
        cursor.index += 1
        const children = parseContainer(cursor, 'link_close')
        nodes.push({ type: 'link', href, title, children })
        break
      }
      case 'image': {
        nodes.push({
          type: 'image',
          src: getTokenStringAttr(token, 'src') ?? '',
          alt: token.content,
          title: getTokenStringAttr(token, 'title'),
        })
        cursor.index += 1
        break
      }
      case 'math_inline': {
        nodes.push({ type: 'math', value: token.content, display: token.markup === '$$' })
        cursor.index += 1
        break
      }
      case 'html_inline':
        // 与 react-markdown 未启用 rehype-raw 时一致：标签按字面量显示。
        pushTextNodes(nodes, token.content ?? '')
        cursor.index += 1
        break
      default:
        throw new Error(`未知行内 token: ${token.type}`)
    }
  }

  if (terminator) throw new Error(`行内标记未闭合: ${terminator}`)
  return nodes
}

/** 解析 inline token 的 children 列表。 */
export function parseInlineChildren(token: MarkdownTokenLike): MarkdownInlineNode[] {
  const cursor: InlineCursor = { tokens: token.children ?? [], index: 0 }
  return parseInlineNodes(cursor, null)
}