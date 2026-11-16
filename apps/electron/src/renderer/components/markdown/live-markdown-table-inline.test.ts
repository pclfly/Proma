import { describe, expect, test } from 'bun:test'
import { liveMarkdownTableCellDraft, renderLiveMarkdownTableInline } from './live-markdown-table-inline'

describe('表格单元格渲染', () => {
  test('Given 非Vault宿主 When 含双链 Then 保持字面文本而非无响应按钮', () => {
    const html = renderLiveMarkdownTableInline('见 [[Note]] 与 [[B|别名]]')
    expect(html).toContain('[[Note]]')
    expect(html).toContain('[[B|别名]]')
    expect(html).not.toContain('data-vault-wikilink-target')
  })
  test('Given Vault宿主 When 普通双链 Then 输出可点击目标与标签', () => {
    const html = renderLiveMarkdownTableInline('[[Note]]', { vaultWikiLinks: true })
    expect(html).toContain('class="vault-wikilink-inline"')
    expect(html).toContain('data-vault-wikilink-target="Note"')
    expect(html).toContain('>Note</span>')
    expect(html).toContain('role="link"')
    const alias = renderLiveMarkdownTableInline('[[Folder/B|别名]]', { vaultWikiLinks: true })
    expect(alias).toContain('data-vault-wikilink-target="Folder/B"')
    expect(alias).toContain('>别名</span>')
  })
  test('Given Vault宿主 When 嵌入/转义/代码/标题目标 Then 均不改写为链接', () => {
    const cases = ['![[image.png]]', '\\[[Note]]', '`[[Note]]`', '[[#标题]]', '[[Note#标题]]']
    for (const value of cases) {
      const html = renderLiveMarkdownTableInline(value, { vaultWikiLinks: true })
      expect(html).not.toContain('data-vault-wikilink-target')
    }
  })
  test('Given Vault宿主 When 目标或标签含HTML Then 转义而不注入', () => {
    const html = renderLiveMarkdownTableInline('[[a"b|<img src=x onerror=alert(1)>]]', { vaultWikiLinks: true })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&quot;')
  })
  test('Given 标签含HTML实体 When Vault渲染 Then 只解码一次并安全转义', () => {
    const html = renderLiveMarkdownTableInline('[[Note|&lt;tag&gt;]]', { vaultWikiLinks: true })
    expect(html).toContain('>&lt;tag&gt;</span>')
    expect(html).not.toContain('&amp;lt;')
  })
  test('Given 原有格式 When 渲染 Then 强调/公式/代码仍工作且换行可回到草稿', () => {
    expect(renderLiveMarkdownTableInline('**粗体**')).toContain('<strong>粗体</strong>')
    expect(renderLiveMarkdownTableInline('$x^2$')).toContain('live-markdown-table-math')
    expect(renderLiveMarkdownTableInline('`code`')).toContain('<code>code</code>')
    expect(liveMarkdownTableCellDraft('第一行<br>第二行')).toBe('第一行\n第二行')
  })
})
