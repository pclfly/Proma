import { describe, expect, test } from 'bun:test'
import { parseCustomMarkdown, parseMarkdownTokens } from './custom-markdown-tokens'
import type {
  MarkdownBlockNode,
  MarkdownCodeBlockNode,
  MarkdownInlineNode,
  MarkdownListNode,
  MarkdownParagraphNode,
  MarkdownTableNode,
  MarkdownTokenLike,
} from './custom-markdown-types'

function parseOk(source: string): MarkdownBlockNode[] {
  const result = parseCustomMarkdown(source)
  if (!result.ok) throw new Error(`解析失败：${result.reason}`)
  return result.nodes
}

function firstParagraph(nodes: MarkdownBlockNode[]): MarkdownParagraphNode {
  const first = nodes[0]
  if (!first || first.type !== 'paragraph') throw new Error('首块不是段落')
  return first
}

function asCodeBlock(node: MarkdownBlockNode | undefined): MarkdownCodeBlockNode {
  if (!node || node.type !== 'codeBlock') throw new Error('不是代码块')
  return node
}

function asList(node: MarkdownBlockNode | undefined): MarkdownListNode {
  if (!node || node.type !== 'list') throw new Error('不是列表')
  return node
}

function asTable(node: MarkdownBlockNode | undefined): MarkdownTableNode {
  if (!node || node.type !== 'table') throw new Error('不是表格')
  return node
}

/** 递归收集行内文本，用于验证“不丢内容” */
function inlineText(nodes: readonly MarkdownInlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'math':
        return node.value
      case 'image':
        return node.alt
      case 'break':
        return '\n'
      case 'link':
      case 'strong':
      case 'emphasis':
      case 'delete':
        return inlineText(node.children)
      default:
        return ''
    }
  }).join('')
}

function blockText(nodes: readonly MarkdownBlockNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        return inlineText(node.children)
      case 'blockquote':
        return blockText(node.children)
      case 'list':
        return node.items.map((item) => blockText(item.children)).join('')
      case 'codeBlock':
      case 'math':
        return node.value
      case 'table':
        return [...node.header, ...node.rows.flat()].map(inlineText).join('')
      case 'thematicBreak':
        return ''
      default:
        return ''
    }
  }).join('')
}

function token(overrides: Partial<MarkdownTokenLike> & { type: string }): MarkdownTokenLike {
  return {
    tag: '',
    hidden: false,
    attrs: null,
    content: '',
    info: '',
    markup: '',
    children: null,
    ...overrides,
  }
}

describe('自研 Markdown 管线：块级语法', () => {
  test('Given 一到六级标题 When 解析 Then 生成对应层级', () => {
    const nodes = parseOk('# 一级\n\n###### 六级')
    expect(nodes[0]).toMatchObject({ type: 'heading', depth: 1 })
    expect(nodes[1]).toMatchObject({ type: 'heading', depth: 6 })
    expect(inlineText((nodes[1] as { children: MarkdownInlineNode[] }).children)).toBe('六级')
  })

  test('Given 段落含强调/加粗/删除线 When 解析 Then 生成对应行内节点', () => {
    const paragraph = firstParagraph(parseOk('普通 **粗体** *斜体* ~~删除~~'))
    expect(paragraph.children.map((node) => node.type)).toEqual([
      'text', 'strong', 'text', 'emphasis', 'text', 'delete',
    ])
    expect(paragraph.tight).toBe(false)
  })

  test('Given 分隔线与引用 When 解析 Then 生成 hr 与 blockquote', () => {
    const nodes = parseOk('---\n\n> 引用内容')
    expect(nodes[0]).toEqual({ type: 'thematicBreak' })
    expect(nodes[1]).toMatchObject({ type: 'blockquote' })
    expect(blockText(nodes.slice(1))).toBe('引用内容')
  })

  test('Given 单换行 When 解析 Then 软换行按硬换行保留', () => {
    const paragraph = firstParagraph(parseOk('第一行\n第二行'))
    expect(paragraph.children.map((node) => node.type)).toEqual(['text', 'break', 'text'])
  })

  test('Given 未标注语言的缩进代码块 When 解析 Then 语言为空', () => {
    const nodes = parseOk('    indented code')
    expect(asCodeBlock(nodes[0])).toMatchObject({ type: 'codeBlock', language: null })
    expect(asCodeBlock(nodes[0]).value).toContain('indented code')
  })
})

describe('自研 Markdown 管线：行内语法', () => {
  test('Given 链接与图片 When 解析 Then 保留 href/src/title/alt', () => {
    const paragraph = firstParagraph(parseOk('[链接](https://example.com "外部") ![图](a.png "配图")'))
    expect(paragraph.children[0]).toMatchObject({
      type: 'link', href: 'https://example.com', title: '外部',
    })
    expect(paragraph.children[2]).toMatchObject({
      type: 'image', src: 'a.png', alt: '图', title: '配图',
    })
  })

  test('Given 行内代码 When 解析 Then 不解析其中的 Markdown 与 mention', () => {
    const paragraph = firstParagraph(parseOk('调用 `render(**x**) @file:/repo/a.md` 完成'))
    expect(paragraph.children[1]).toEqual({
      type: 'inlineCode',
      value: 'render(**x**) @file:/repo/a.md',
    })
  })

  test('Given mention 语法 When 解析 Then 生成 mention:// 链接且行内代码不参与', () => {
    const paragraph = firstParagraph(parseOk('@file:/repo/notes.md 见 `@file:/repo/code.md`'))
    expect(paragraph.children[0]).toEqual({
      type: 'link',
      href: 'mention://file/%2Frepo%2Fnotes.md',
      children: [{ type: 'text', value: '@file:/repo/notes.md' }],
    })
    expect(paragraph.children[2]).toMatchObject({ type: 'inlineCode' })
  })

  test('Given named reference 带已编码标题 When 解析 Then 整个值重新编码', () => {
    const paragraph = firstParagraph(parseOk('&session:abc123~%E9%9C%80%E6%B1%82'))
    expect(paragraph.children[0]).toMatchObject({
      type: 'link',
      href: 'mention://session/abc123%3A%3A%E9%9C%80%E6%B1%82',
    })
  })

  test('Given 行内与块级公式 When 解析 Then 保留 display 语义', () => {
    const inlineNodes = parseOk('质能方程 $E=mc^2$ 结束')
    expect(firstParagraph(inlineNodes).children[1]).toEqual({
      type: 'math', value: 'E=mc^2', display: false,
    })

    const blockNodes = parseOk('$$\n\\int_0^1 x\\,dx\n$$')
    const blockMath = blockNodes[0]
    expect(blockMath).toMatchObject({ type: 'math', display: true })
    if (!blockMath || blockMath.type !== 'math') throw new Error('不是公式块')
    expect(blockMath.value).toContain('int_0^1')
  })

  test('Given 转义与尖括号文本 When 解析 Then 原样保留且不触发回退', () => {
    const result = parseCustomMarkdown('当 5 < 6 且 \\*不是强调\\* 时')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(blockText(result.nodes)).toBe('当 5 < 6 且 *不是强调* 时')
  })
})

describe('自研 Markdown 管线：列表、任务列表与表格', () => {
  test('Given 有序与无序列表 When 解析 Then 保留类型与起始序号', () => {
    const nodes = parseOk('- 一\n- 二\n\n3. 三\n4. 四')
    const bullet = asList(nodes[0])
    expect(bullet.ordered).toBe(false)
    expect(bullet.items).toHaveLength(2)
    expect(blockText(bullet.items[0]!.children)).toBe('一')

    const ordered = asList(nodes[1])
    expect(ordered.ordered).toBe(true)
    expect(ordered.start).toBe(3)
    expect(ordered.items).toHaveLength(2)
  })

  test('Given 任务列表 When 解析 Then 标记升级为 taskItem 且正文不含 [x]', () => {
    const list = asList(parseOk('- [ ] 待办\n- [x] 已完成')[0])
    expect(list.items[0]).toMatchObject({ type: 'taskItem', checked: false })
    expect(list.items[1]).toMatchObject({ type: 'taskItem', checked: true })
    expect(blockText(list.items[0]!.children)).toBe('待办')
    expect(blockText(list.items[1]!.children)).toBe('已完成')
  })

  test('Given 表格 When 解析 Then 对齐信息与表头/单元格正确', () => {
    const table = asTable(parseOk('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |')[0])
    expect(table.align).toEqual(['left', 'center', 'right'])
    expect(table.header.map(inlineText)).toEqual(['左', '中', '右'])
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]!.map(inlineText)).toEqual(['a', 'b', 'c'])
  })
})

describe('自研 Markdown 管线：代码块与回退', () => {
  test('Given 带语言的围栏代码 When 解析 Then 语言识别且内容不被 Markdown 化', () => {
    const code = asCodeBlock(parseOk('```ts title=demo.ts\nconst a = 1\n```')[0])
    expect(code.language).toBe('ts')
    expect(code.value).toBe('const a = 1\n')

    const rich = asCodeBlock(parseOk('```html\n<div>代码</div>\n$不是公式$ @file:/repo/a.md\n```')[0])
    expect(rich.value).toContain('<div>代码</div>')
    expect(rich.value).toContain('$不是公式$')
  })

  test('Given 原始 HTML When 解析 Then 按字面量保留且不回退', () => {
    const cases = ['<div>块级</div>', '行内 <span>标签</span>', '<!-- 注释 -->']
    for (const source of cases) {
      const result = parseCustomMarkdown(source)
      if (!result.ok) throw new Error(result.reason)
      const text = JSON.stringify(result.nodes)
      expect(text).toContain(source.includes('注释') ? '注释' : source.includes('块级') ? '块级' : '标签')
    }
  })

  test('Given 围栏代码里的 HTML When 解析 Then 不触发回退', () => {
    const result = parseCustomMarkdown('```html\n<div>示例</div>\n```')
    expect(result.ok).toBe(true)
  })

  test('Given 畸形 Markdown When 解析 Then 文本不丢', () => {
    const source = '**未闭合强调\n\n[未闭合链接(https://example.com\n\n`未闭合代码'
    const nodes = parseOk(source)
    const text = blockText(nodes)
    expect(text).toContain('未闭合强调')
    expect(text).toContain('未闭合链接')
    expect(text).toContain('未闭合代码')
  })

  test('Given 嵌套列表与引用 When 解析 Then 结构完整', () => {
    const quoteNodes = parseOk('> 引用段落\n>\n> - 一\n>   - 嵌套')
    const quote = quoteNodes[0]
    if (!quote || quote.type !== 'blockquote') throw new Error('首块不是引用')
    const list = asList(quote.children.find((child) => child.type === 'list'))
    expect(list.items[0]!.children.some((child) => child.type === 'list')).toBe(true)
  })

  test('Given 行内代码里的 HTML When 解析 Then 不触发回退', () => {
    const result = parseCustomMarkdown('使用 `<div>` 标签')
    expect(result.ok).toBe(true)
  })

  test('Given 未知 token 或未闭合容器 When 解析 token 流 Then 抛错以便上层回退', () => {
    expect(() => parseMarkdownTokens([token({ type: 'mystery_block' })])).toThrow()
    expect(() => parseMarkdownTokens([
      token({ type: 'paragraph_open' }),
      token({ type: 'inline', children: [token({ type: 'text', content: '缺闭合' })] }),
    ])).toThrow()
  })
})