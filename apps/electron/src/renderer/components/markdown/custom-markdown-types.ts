/**
 * 自研 Markdown 渲染管线的虚拟节点模型。
 *
 * 解析层（custom-markdown-tokens / custom-markdown-inline）只产出这些纯数据结构，
 * 渲染层（custom-markdown-node）再映射为 React 元素。两层分开后，token → 节点的
 * 映射可以在没有 DOM 的环境（bun test）里直接验证。
 */

/** 表格列对齐；null 表示未声明对齐 */
export type MarkdownAlign = 'left' | 'center' | 'right' | null

/** 标题层级 */
export type MarkdownHeadingDepth = 1 | 2 | 3 | 4 | 5 | 6

export interface MarkdownTextNode {
  type: 'text'
  value: string
}

export interface MarkdownEmphasisNode {
  type: 'emphasis'
  children: MarkdownInlineNode[]
}

export interface MarkdownStrongNode {
  type: 'strong'
  children: MarkdownInlineNode[]
}

export interface MarkdownDeleteNode {
  type: 'delete'
  children: MarkdownInlineNode[]
}

export interface MarkdownLinkNode {
  type: 'link'
  href: string
  title?: string
  children: MarkdownInlineNode[]
}

export interface MarkdownImageNode {
  type: 'image'
  src: string
  alt: string
  title?: string
}

export interface MarkdownInlineCodeNode {
  type: 'inlineCode'
  value: string
}

export interface MarkdownBreakNode {
  type: 'break'
}

/** KaTeX 公式；display 为 true 表示块级 `$$...$$` */
export interface MarkdownMathNode {
  type: 'math'
  value: string
  display: boolean
}

export type MarkdownInlineNode =
  | MarkdownTextNode
  | MarkdownEmphasisNode
  | MarkdownStrongNode
  | MarkdownDeleteNode
  | MarkdownLinkNode
  | MarkdownImageNode
  | MarkdownInlineCodeNode
  | MarkdownBreakNode
  | MarkdownMathNode

export interface MarkdownParagraphNode {
  type: 'paragraph'
  /** 紧凑列表项内的段落不套 <p>，与 react-markdown 的输出形态一致 */
  tight: boolean
  children: MarkdownInlineNode[]
}

export interface MarkdownHeadingNode {
  type: 'heading'
  depth: MarkdownHeadingDepth
  children: MarkdownInlineNode[]
}

export interface MarkdownBlockquoteNode {
  type: 'blockquote'
  children: MarkdownBlockNode[]
}

export interface MarkdownListItemNode {
  type: 'listItem'
  children: MarkdownBlockNode[]
}

/** GFM 任务列表项，`[ ]` / `[x]` 前缀已从正文剥离 */
export interface MarkdownTaskItemNode {
  type: 'taskItem'
  checked: boolean
  children: MarkdownBlockNode[]
}

export type MarkdownListEntryNode = MarkdownListItemNode | MarkdownTaskItemNode

export interface MarkdownListNode {
  type: 'list'
  ordered: boolean
  /** 有序列表起始序号 */
  start: number
  items: MarkdownListEntryNode[]
}

export interface MarkdownCodeBlockNode {
  type: 'codeBlock'
  /** 代码原文（保留 markdown-it 给出的结尾换行） */
  value: string
  /** 围栏语言，未标注时为 null */
  language: string | null
}

export interface MarkdownThematicBreakNode {
  type: 'thematicBreak'
}

export interface MarkdownTableNode {
  type: 'table'
  align: MarkdownAlign[]
  header: MarkdownInlineNode[][]
  rows: MarkdownInlineNode[][][]
}

export type MarkdownBlockNode =
  | MarkdownParagraphNode
  | MarkdownHeadingNode
  | MarkdownBlockquoteNode
  | MarkdownListNode
  | MarkdownCodeBlockNode
  | MarkdownThematicBreakNode
  | MarkdownTableNode
  | MarkdownMathNode

/**
 * markdown-it Token 的结构子集。
 * 用结构类型而不是直接依赖 Token 类，测试可以构造最小 token 序列。
 */
export interface MarkdownTokenLike {
  type: string
  tag: string
  hidden: boolean
  attrs: Array<[string, string | number]> | null
  content: string
  info: string
  markup: string
  children: MarkdownTokenLike[] | null
}

export interface CustomMarkdownParseSuccess {
  ok: true
  nodes: MarkdownBlockNode[]
}

export interface CustomMarkdownParseFailure {
  ok: false
  /** 回退原因，便于排查；不展示给用户 */
  reason: string
}

export type CustomMarkdownParseResult = CustomMarkdownParseSuccess | CustomMarkdownParseFailure