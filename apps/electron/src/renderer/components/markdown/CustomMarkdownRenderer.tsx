import * as React from 'react'
import { renderMarkdownBlocks } from './custom-markdown-node'
import { parseCustomMarkdown } from './custom-markdown-tokens'
import type { CustomMarkdownComponents } from './custom-markdown-node'

export type { CustomMarkdownComponents }

/**
 * 自研 Markdown 渲染器：markdown-it token → 虚拟节点 → React 元素。
 *
 * 回退策略是「整条消息」级别的：
 * - 调用方传入额外 remark 插件（shouldUseCustomMarkdownRenderer 为 false）时直接用 react-markdown；
 * - 解析失败、命中原始 HTML、遇到未知 token 时，组件整体交给 fallback 渲染，
 *   不会出现一条消息里一半新管线一半旧管线的情况。
 */

interface CustomMarkdownRendererProps {
  /** 已完成 LaTeX / 强调规范化处理的 Markdown 源文本 */
  source: string
  /** 链接、图片、代码块等注入组件，语义与 react-markdown 的 components 一致 */
  components: CustomMarkdownComponents
  /** 解析失败时的整条消息回退渲染（react-markdown 路径） */
  fallback: () => React.ReactNode
}

/** 调用方额外传入 remark 插件时必须回退，保证插件语义不丢失。 */
export function shouldUseCustomMarkdownRenderer(remarkPlugins?: readonly unknown[]): boolean {
  return !remarkPlugins || remarkPlugins.length === 0
}

export function CustomMarkdownRenderer({
  source,
  components,
  fallback,
}: CustomMarkdownRendererProps): React.ReactElement {
  const parsed = React.useMemo(() => parseCustomMarkdown(source), [source])

  if (!parsed.ok) {
    return <>{fallback()}</>
  }

  return <>{renderMarkdownBlocks(parsed.nodes, components)}</>
}