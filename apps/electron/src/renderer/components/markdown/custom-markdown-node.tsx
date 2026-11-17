import * as React from 'react'
import katex from 'katex'
import type {
  MarkdownBlockNode,
  MarkdownCodeBlockNode,
  MarkdownHeadingDepth,
  MarkdownInlineNode,
  MarkdownListEntryNode,
  MarkdownListNode,
  MarkdownTableNode,
} from './custom-markdown-types'

/**
 * 虚拟节点 → React 元素。
 *
 * 所有文本都作为 React children 输出（自动转义），只有 KaTeX 生成的 HTML
 * 走 dangerouslySetInnerHTML；链接、图片、代码块一律走注入的组件，
 * 从而保留 message.tsx 里已有的路径授权与 Shiki/Mermaid 能力。
 */

/** 渲染器依赖：由 MessageResponse 注入，避免这里反向依赖 message.tsx。 */
export interface CustomMarkdownComponents {
  link: React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>
  image: React.ComponentType<React.ImgHTMLAttributes<HTMLImageElement>>
  pre: React.ComponentType<{ children?: React.ReactNode }>
  code: React.ComponentType<React.HTMLAttributes<HTMLElement>>
  transformUrl: (url: string) => string
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const

/**
 * KaTeX 输出的是受控 HTML：默认 trust: false、throwOnError: false 时 KaTeX 会
 * 转义文本内容，只生成自己的排版标签，因此可以安全地写入 innerHTML。
 * 渲染异常时退回纯文本节点，绝不把原始 LaTeX 当 HTML 插入。
 */
function MarkdownMath({ value, display }: { value: string; display: boolean }): React.ReactElement {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(value, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: false,
      })
    } catch {
      return null
    }
  }, [value, display])

  if (!html) {
    return display
      ? <div className="my-2 overflow-x-auto text-center font-mono text-sm">{value}</div>
      : <code>{value}</code>
  }

  return display
    ? <div className="my-2 overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: html }} />
    : <span dangerouslySetInnerHTML={{ __html: html }} />
}

function renderInlineNode(
  node: MarkdownInlineNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactNode {
  switch (node.type) {
    case 'text':
      return <React.Fragment key={key}>{node.value}</React.Fragment>
    case 'emphasis':
      return <em key={key}>{renderInlineNodes(node.children, components, `${String(key)}-em`)}</em>
    case 'strong':
      return <strong key={key}>{renderInlineNodes(node.children, components, `${String(key)}-strong`)}</strong>
    case 'delete':
      return <del key={key}>{renderInlineNodes(node.children, components, `${String(key)}-del`)}</del>
    case 'link': {
      const Link = components.link
      return (
        <Link key={key} href={components.transformUrl(node.href)} title={node.title}>
          {renderInlineNodes(node.children, components, `${String(key)}-a`)}
        </Link>
      )
    }
    case 'image': {
      const Image = components.image
      return (
        <Image
          key={key}
          src={components.transformUrl(node.src)}
          alt={node.alt}
          title={node.title}
        />
      )
    }
    case 'inlineCode': {
      const Code = components.code
      return <Code key={key}>{node.value}</Code>
    }
    case 'break':
      return <br key={key} />
    case 'math':
      return <MarkdownMath key={key} value={node.value} display={node.display} />
    default:
      return null
  }
}

function renderCodeBlock(
  node: MarkdownCodeBlockNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactElement {
  const Pre = components.pre
  const Code = components.code
  // 与 react-markdown 的输出形态一致：<pre> 内套带 language-* 的 <code>，
  // MarkdownPre 依赖这个结构做 Mermaid 判定与语言探测。
  return (
    <Pre key={key}>
      <Code className={node.language ? `language-${node.language}` : undefined}>{node.value}</Code>
    </Pre>
  )
}

function renderListEntry(
  entry: MarkdownListEntryNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactElement {
  const children = renderMarkdownBlocks(entry.children, components)
  if (entry.type === 'taskItem') {
    return (
      <li key={key} className="task-list-item">
        <input
          type="checkbox"
          checked={entry.checked}
          readOnly
          disabled
          className="mr-1.5 align-middle"
        />
        {children}
      </li>
    )
  }
  return <li key={key}>{children}</li>
}

function renderList(
  node: MarkdownListNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactElement {
  const items = node.items.map((item, index) => renderListEntry(item, components, `${String(key)}-${index}`))
  return node.ordered
    ? <ol key={key} start={node.start !== 1 ? node.start : undefined}>{items}</ol>
    : <ul key={key}>{items}</ul>
}

function renderTable(
  node: MarkdownTableNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactElement {
  return (
    <table key={key}>
      <thead>
        <tr>
          {node.header.map((cell, index) => (
            <th key={index} style={{ textAlign: node.align[index] ?? undefined }}>
              {renderInlineNodes(cell, components, `${String(key)}-th-${index}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {node.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} style={{ textAlign: node.align[cellIndex] ?? undefined }}>
                {renderInlineNodes(cell, components, `${String(key)}-td-${rowIndex}-${cellIndex}`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderBlockNode(
  node: MarkdownBlockNode,
  components: CustomMarkdownComponents,
  key: React.Key
): React.ReactElement | null {
  switch (node.type) {
    case 'paragraph': {
      const children = renderInlineNodes(node.children, components, `${String(key)}-p`)
      return node.tight
        ? <React.Fragment key={key}>{children}</React.Fragment>
        : <p key={key}>{children}</p>
    }
    case 'heading': {
      const Tag = HEADING_TAGS[node.depth as MarkdownHeadingDepth]
      return <Tag key={key}>{renderInlineNodes(node.children, components, `${String(key)}-h`)}</Tag>
    }
    case 'blockquote':
      return <blockquote key={key}>{renderMarkdownBlocks(node.children, components)}</blockquote>
    case 'list':
      return renderList(node, components, key)
    case 'codeBlock':
      return renderCodeBlock(node, components, key)
    case 'thematicBreak':
      return <hr key={key} />
    case 'table':
      return renderTable(node, components, key)
    case 'math':
      return <MarkdownMath key={key} value={node.value} display />
    default:
      return null
  }
}

/** 块级节点列表 → React 节点数组 */
export function renderMarkdownBlocks(
  nodes: readonly MarkdownBlockNode[],
  components: CustomMarkdownComponents
): React.ReactNode[] {
  return nodes.map((node, index) => renderBlockNode(node, components, index))
}

/** 行内节点列表 → React 节点数组 */
export function renderInlineNodes(
  nodes: readonly MarkdownInlineNode[],
  components: CustomMarkdownComponents,
  keyPrefix = 'inline'
): React.ReactNode[] {
  return nodes.map((node, index) => renderInlineNode(node, components, `${keyPrefix}-${index}`))
}