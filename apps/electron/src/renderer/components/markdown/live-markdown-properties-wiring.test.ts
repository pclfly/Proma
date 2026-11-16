import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const editor = readFileSync(new URL('./LiveMarkdownEditor.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('./LiveMarkdownPreview.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../vault/VaultLiveMarkdownEditor.tsx', import.meta.url), 'utf8')

test('Given 仅外部EOL变化 When normalized早退 Then 仍有显式RawSource同步和独立历史边界', () => {
  const branch = editor.slice(editor.indexOf("    if (instance.getDoc() === value.replace"), editor.indexOf('// External document refreshes'))
  expect(branch).toContain('source.getSource() !== value')
  expect(branch).toContain('source.synchronize(value)')
  expect(branch).toContain("isolateHistory.of('full')")
})

test('Given Vault Properties When 写入 Then 使用实时view局部事务而不是旧数组全文序列化', () => {
  expect(adapter).not.toContain('serializeFlatLeadingFrontmatter')
  expect(preview).toContain('planMarkdownPropertyEdit(view.state.doc.toString(), edit)')
  expect(preview).toContain('this.disposed || view.state.readOnly')
  expect(preview).toContain("annotations: isolateHistory.of('full')")
  expect(editor).toContain("{ type: 'grammar', value: markdownFrontmatterGrammar }")
  expect(editor).toContain('rawSource.extension')
})
