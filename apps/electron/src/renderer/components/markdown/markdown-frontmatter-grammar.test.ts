import { expect, test } from 'bun:test'
import { parser } from '@lezer/markdown'
import { EditorState } from '@codemirror/state'
import { markdownFrontmatterGrammar } from './markdown-frontmatter-grammar'
import { canRenderVaultWikiLink } from '../vault/vault-wikilinks'

test('Given 首部YAML源码 When Markdown解析 Then 内部无Heading/ListMark/Emphasis，正文仍有标题', () => {
  const source = '---  \n# important YAML comment\ntitle: "*not emphasis*"\nlist:\n  - one\n---\n# 正文标题\n'
  const tree = parser.configure(markdownFrontmatterGrammar).parse(source)
  expect(tree.toString()).toBe('Document(YamlFrontmatter,ATXHeading1(HeaderMark))')
})

test('Given BOM/首围栏尾空白 When Vault双链解析 Then YAML内部不转换而正文可转换', () => {
  for (const first of ['---  ', '\uFEFF---\t', '---']) {
    const source = `${first}\nkey: "[[target]]"\n---\n[[body]]`
    const state = EditorState.create({ doc: source })
    expect(canRenderVaultWikiLink(state, source.indexOf('[['))).toBe(false)
    expect(canRenderVaultWikiLink(state, source.lastIndexOf('[['))).toBe(true)
  }
})
