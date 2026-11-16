import { describe, expect, test } from 'bun:test'
import { preserveMarkdownLineEndings } from './markdown-line-endings'

describe('Markdown未改换行保留', () => {
  test('Given BOM/混合换行/无尾换行 When 单属性变化 Then 其余字节不变', () => {
    const old = '\uFEFF---\r\na: old\r\nb: keep\n---\r\nbody\nno end'
    expect(preserveMarkdownLineEndings(old, old.replace(/\r\n?/g, '\n').replace('a: old', 'a: new'))).toBe(old.replace('a: old', 'a: new'))
  })
  test('Given CRLF When 新增删除行 Then 未改首尾保留且新增使用原主要分隔符', () => {
    const old = 'one\r\ntwo\r\nthree\nlast'
    const next = preserveMarkdownLineEndings(old, 'one\nnew\nadded\nthree\nlast')
    expect(next).toBe('one\r\nnew\r\nadded\r\nthree\nlast')
    expect(preserveMarkdownLineEndings(next, 'one\nthree\nlast')).toBe('one\r\nthree\nlast')
  })
  test('Given 仅编辑器规范化 When 正文没变化 Then 精确返回原字符串', () => {
    const old = 'a\rb\r\nc\nd'
    expect(preserveMarkdownLineEndings(old, 'a\nb\nc\nd')).toBe(old)
  })
})

import { EditorState, Transaction } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { createMarkdownRawSource } from './markdown-line-endings'
import { parseMarkdownProperties, planMarkdownPropertyEdit } from './live-markdown-properties'

describe('原文状态随CodeMirror历史往返', () => {
  test('Given 删除混合EOL属性 When Undo/Redo Then 原分隔符随逆向effect精确恢复', () => {
    const original = '---\r\na: old\nb: keep\r\n---\r\nbody'
    const source = createMarkdownRawSource(original)
    let state = EditorState.create({ doc: original, extensions: [history(), source.extension] })
    const edit = planMarkdownPropertyEdit(state.doc.toString(), { kind: 'remove', path: ['a'], expectedFrontmatter: parseMarkdownProperties(state.doc.toString()).source })
    expect(edit.status).toBe('changed')
    state = state.update({ changes: edit.change, annotations: Transaction.userEvent.of('input.properties') }).state
    const deleted = source.getSource()
    expect(deleted).toBe(original.replace('a: old\n', ''))
    const target = { get state() { return state }, dispatch(transaction: Transaction) { state = transaction.state } }
    expect(undo(target)).toBe(true)
    expect(source.getSource()).toBe(original)
    expect(redo(target)).toBe(true)
    expect(source.getSource()).toBe(deleted)
  })
  test('Given 多区域变更 When 同事务两端修改 Then 中间未改LF不变', () => {
    const original = 'a\r\nkeep\nb\r\nend'
    const source = createMarkdownRawSource(original)
    const state = EditorState.create({ doc: original, extensions: [source.extension] })
    void state.update({ changes: [{ from: 0, to: 1, insert: 'A' }, { from: 7, to: 8, insert: 'B' }] }).state
    expect(source.getSource()).toBe('A\r\nkeep\nB\r\nend')
  })
  test('Given 外部原文刷新 When 编辑器同步 Then 使用外部精确换行而非旧分隔符', () => {
    let external: string | null = null
    const source = createMarkdownRawSource('a\nb', () => external)
    const state = EditorState.create({ doc: 'a\nb', extensions: [source.extension] })
    external = 'c\r\nd\r\n'
    void state.update({ changes: { from: 0, to: state.doc.length, insert: external } }).state
    expect(source.getSource()).toBe(external)
  })
})

test('Given 外部只改EOL When 显式同步、修改属性并Undo/Redo Then 原文历史不退回旧格式', () => {
  const original = '---\na: old\n---\nbody'
  const refreshed = original.replace(/\n/g, '\r\n')
  const raw = createMarkdownRawSource(original)
  let state = EditorState.create({ doc: original, extensions: [history(), raw.extension] })
  state = state.update({ effects: raw.synchronize(refreshed), annotations: Transaction.userEvent.of('input.external') }).state
  expect(raw.getSource()).toBe(refreshed)
  const plan = planMarkdownPropertyEdit(state.doc.toString(), { kind: 'set', path: ['a'], scalarType: 'string', value: 'new', expectedFrontmatter: parseMarkdownProperties(state.doc.toString()).source })
  state = state.update({ changes: plan.change, annotations: Transaction.userEvent.of('input.properties') }).state
  expect(raw.getSource()).toBe(refreshed.replace('old', 'new'))
  const target = { get state() { return state }, dispatch(transaction: Transaction) { state = transaction.state } }
  expect(undo(target)).toBe(true)
  expect(raw.getSource()).toBe(refreshed)
  expect(undo(target)).toBe(true)
  expect(raw.getSource()).toBe(original)
  expect(redo(target)).toBe(true)
  expect(raw.getSource()).toBe(refreshed)
  expect(redo(target)).toBe(true)
  expect(raw.getSource()).toBe(refreshed.replace('old', 'new'))
})
