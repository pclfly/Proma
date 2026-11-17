import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CustomMarkdownRenderer, shouldUseCustomMarkdownRenderer } from './CustomMarkdownRenderer'
import type { CustomMarkdownComponents } from './custom-markdown-node'

/**
 * 用轻量替身验证渲染接线：不初始化 Shiki/Mermaid，只断言结构、属性与文本。
 * 真实高亮与 Mermaid 判定仍由 message.tsx 注入的 MarkdownPre / CodeBlock 负责。
 */
function createComponents(overrides?: Partial<CustomMarkdownComponents>): CustomMarkdownComponents {
  return {
    link: ({ href, title, children }) => <a data-link href={href} title={title}>{children}</a>,
    image: ({ src, alt, title }) => <img data-image src={src} alt={alt} title={title} />,
    pre: ({ children }) => <pre data-pre>{children}</pre>,
    code: ({ className, children }) => <code data-code className={className}>{children}</code>,
    transformUrl: (url) => url,
    ...overrides,
  }
}

function render(source: string, overrides?: Partial<CustomMarkdownComponents>): string {
  return renderToStaticMarkup(
    <CustomMarkdownRenderer
      source={source}
      components={createComponents(overrides)}
      // 回退内容带上完整源码：可证明是“整条消息”交给旧管线，而非片段降级。
      fallback={() => <pre data-fallback>{source}</pre>}
    />
  )
}

describe('CustomMarkdownRenderer 渲染接线', () => {
  test('Given 普通 Markdown When 渲染 Then 不需要回退', () => {
    const markup = render('# 标题\n\n**粗体**与 *斜体*')
    expect(markup).toContain('<h1>标题</h1>')
    expect(markup).toContain('<strong>粗体</strong>')
    expect(markup).toContain('<em>斜体</em>')
    expect(markup).not.toContain('data-fallback')
  })

  test('Given 原始 HTML When 渲染 Then 按字面量展示且不整条回退', () => {
    const source = '<div>块级</div>\n\n之后的段落'
    const markup = render(source)
    // 与 react-markdown 未启用 rehype-raw 的行为一致：标签是文本，不是 DOM。
    expect(markup).not.toContain('data-fallback')
    expect(markup).not.toContain('<div')
    expect(markup).toContain('&lt;div&gt;块级&lt;/div&gt;')
    expect(markup).toContain('之后的段落')
  })

  test('Given 围栏代码 When 渲染 Then 保留 language-* 类名与代码原文', () => {
    const markup = render('```ts\nconst a = 1\n```')
    expect(markup).toContain('<pre data-pre')
    expect(markup).toContain('class="language-ts"')
    expect(markup).toContain('const a = 1')
  })

  test('Given 链接与图片 When 渲染 Then 走注入组件并应用 URL 清洗', () => {
    const markup = render('[链接](https://example.com) ![图](a.png)')
    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('src="a.png"')
    expect(markup).toContain('alt="图"')

    const cleaned = render('[链接](https://example.com)', { transformUrl: () => '#clean' })
    expect(cleaned).toContain('href="#clean"')

    // markdown-it 自身也会拒绝 javascript: 目标，链接退化为文本
    const blocked = render('[危险](javascript:alert(1))')
    expect(blocked).not.toContain('href="javascript')
  })

  test('Given mention 链接 When 渲染 Then 保留 mention:// 交给 MarkdownLink 渲染 chip', () => {
    const markup = render('@file:/repo/notes.md')
    expect(markup).toContain('href="mention://file/%2Frepo%2Fnotes.md"')
  })

  test('Given 任务列表 When 渲染 Then 输出只读 checkbox 且正文已剥离标记', () => {
    const markup = render('- [ ] 待办\n- [x] 已完成')
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('checked=""')
    expect(markup).toContain('待办')
    expect(markup).toContain('已完成')
    expect(markup).not.toContain('[x]')
  })

  test('Given 表格 When 渲染 Then 输出 thead/tbody 与对齐样式', () => {
    const markup = render('| 左 | 右 |\n|:---|:---:|\n| a | b |')
    expect(markup).toContain('<thead>')
    expect(markup).toContain('<tbody>')
    expect(markup).toContain('text-align:left')
    expect(markup).toContain('text-align:center')
  })

  test('Given 数学公式 When 渲染 Then 由 KaTeX 输出而不泄露原始标签', () => {
    const inline = render('公式 $E=mc^2$')
    expect(inline).toContain('class="katex"')

    const block = render('$$\nE=mc^2\n$$')
    expect(block).toContain('class="katex-display"')
  })

  test('Given 纯文本含特殊字符 When 渲染 Then 由 React 转义而不是当 HTML 执行', () => {
    const markup = render('a & b > c "引号"')
    expect(markup).toContain('a &amp; b &gt; c')
    expect(markup).not.toContain('<script')
  })
})

describe('CustomMarkdownRenderer 回退判定', () => {
  const plugin = (): void => {}

  test('Given 未传入 remark 插件 When 判定 Then 使用自研管线', () => {
    expect(shouldUseCustomMarkdownRenderer(undefined)).toBe(true)
    expect(shouldUseCustomMarkdownRenderer([])).toBe(true)
  })

  test('Given 传入额外 remark 插件 When 判定 Then 回退到 react-markdown', () => {
    expect(shouldUseCustomMarkdownRenderer([plugin])).toBe(false)
  })

  test('Given MessageResponse 源码 When 检查接线 Then 默认新管线且保留旧管线回退', () => {
    const source = readFileSync(new URL('../ai-elements/message.tsx', import.meta.url), 'utf8')
    expect(source).toContain("import Markdown, { defaultUrlTransform } from 'react-markdown'")
    expect(source).toContain('<CustomMarkdownRenderer')
    expect(source).toContain('fallback={() => legacyMarkdown}')
    expect(source).toContain('shouldUseCustomMarkdownRenderer(remarkPlugins)')
    // 复用既有渲染器，禁止绕过 Shiki/Mermaid 与文件路径授权
    expect(source).toContain('link: MarkdownLink')
    expect(source).toContain('image: MarkdownImage')
    expect(source).toContain('pre: MarkdownPre')
    expect(source).toContain('code: components.code')
    expect(source).toContain('transformUrl: mentionUrlTransform')
  })
})