import { describe, expect, test } from 'bun:test'
import { isDeletionTransaction, shouldDismissEmptySuggestion } from './mention-popup-utils'

describe('@ 提及无匹配时自动收起', () => {
  test('Given 已输入查询且最新结果为空 When 判定 Then 收起菜单', () => {
    expect(shouldDismissEmptySuggestion({ itemCount: 0, query: 'zzz', isLatestResult: true })).toBe(true)
  })

  test('Given 仅输入触发符 When 结果为空 Then 保留空状态提示', () => {
    expect(shouldDismissEmptySuggestion({ itemCount: 0, query: '', isLatestResult: true })).toBe(false)
    expect(shouldDismissEmptySuggestion({ itemCount: 0, query: '  ', isLatestResult: true })).toBe(false)
  })

  test('Given 初始占位或过期请求的空数组 When 判定 Then 不收起', () => {
    expect(shouldDismissEmptySuggestion({ itemCount: 0, query: 'abc', isLatestResult: false })).toBe(false)
  })

  test('Given 有匹配结果 When 判定 Then 不收起', () => {
    expect(shouldDismissEmptySuggestion({ itemCount: 2, query: 'abc', isLatestResult: true })).toBe(false)
  })
})

describe('删除事务判定', () => {
  const doc = (size: number) => ({ content: { size } })

  test('Given 文档变短 When 判定 Then 视为删除', () => {
    expect(isDeletionTransaction({ docChanged: true, before: doc(10), doc: doc(9) } as never)).toBe(true)
  })

  test('Given 继续输入或文档未变 When 判定 Then 不视为删除', () => {
    expect(isDeletionTransaction({ docChanged: true, before: doc(9), doc: doc(10) } as never)).toBe(false)
    expect(isDeletionTransaction({ docChanged: false, before: doc(10), doc: doc(10) } as never)).toBe(false)
  })
})
