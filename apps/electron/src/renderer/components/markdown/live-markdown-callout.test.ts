import { describe, expect, test } from 'bun:test'
import {
  isLiveMarkdownCalloutStart,
  parseLiveMarkdownCallout,
  renderLiveMarkdownCalloutBody,
} from './live-markdown-callout'

describe('Obsidian Callout 阅读态解析', () => {
  test('Given 标准提示块 When 解析 Then 保留类型/默认标题/正文且去掉引用前缀', () => {
    const callout = parseLiveMarkdownCallout('> [!note]\n> 第一段\n>\n> - 列表')
    expect(callout).toEqual({ type: 'note', kind: 'note', title: 'Note', fold: null, body: '第一段\n\n- 列表' })
  })
  test('Given 自定义标题与折叠标记 When 解析 Then 分别识别展开与折叠', () => {
    expect(parseLiveMarkdownCallout('> [!warning]- 小心\n> 内容')?.fold).toBe('closed')
    expect(parseLiveMarkdownCallout('> [!tip]+ 展开\n> 内容')?.fold).toBe('open')
    expect(parseLiveMarkdownCallout('> [!tip] 自定义标题\n> 内容')?.title).toBe('自定义标题')
  })
  test('Given 类型别名 When 解析 Then 归一为同一强调色语义', () => {
    expect(parseLiveMarkdownCallout('> [!hint]')?.kind).toBe('tip')
    expect(parseLiveMarkdownCallout('> [!caution]')?.kind).toBe('warning')
    expect(parseLiveMarkdownCallout('> [!bug]')?.kind).toBe('danger')
    expect(parseLiveMarkdownCallout('> [!check]')?.kind).toBe('success')
    expect(parseLiveMarkdownCallout('> [!unknown-type]')?.kind).toBe('note')
  })
  test('Given 普通引用/混入非引用行 When 解析 Then 不误判为Callout', () => {
    expect(isLiveMarkdownCalloutStart('> 普通引用')).toBe(false)
    expect(parseLiveMarkdownCallout('> 普通引用')).toBeNull()
    expect(parseLiveMarkdownCallout('> [!note]\n普通段落')).toBeNull()
    expect(parseLiveMarkdownCallout('[!note]')).toBeNull()
  })
  test('Given Callout正文 When 渲染 Then 支持段落/列表/代码且不执行原始HTML', () => {
    const html = renderLiveMarkdownCalloutBody('**粗体**\n\n- 项\n\n```ts\nconst a = 1\n```\n\n<script>x</script>')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<li>项</li>')
    expect(html).toContain('language-ts')
    expect(html).not.toContain('<script>')
  })
  test('Given Vault宿主 When 正文含双链 Then 生成可点击目标，非Vault保持字面', () => {
    const vault = renderLiveMarkdownCalloutBody('见 [[Note|别名]]', { vaultWikiLinks: true })
    expect(vault).toContain('data-vault-wikilink-target="Note"')
    expect(vault).toContain('>别名</span>')
    const plain = renderLiveMarkdownCalloutBody('见 [[Note]]')
    expect(plain).toContain('[[Note]]')
    expect(plain).not.toContain('data-vault-wikilink-target')
  })
  test('Given 空正文 When 渲染 Then 返回空串而不是占位HTML', () => {
    expect(renderLiveMarkdownCalloutBody('')).toBe('')
    expect(renderLiveMarkdownCalloutBody('   \n')).toBe('')
  })
})
