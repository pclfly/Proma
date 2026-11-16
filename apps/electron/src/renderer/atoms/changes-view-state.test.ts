import { createStore } from 'jotai'
import { describe, expect, test } from 'bun:test'
import { changesViewStatesAtom, updateChangesViewAtom } from './changes-view-state'

describe('Changes 浏览状态', () => {
  test('Given A/B会话和不同工作树 When 保存和恢复 Then 各自独立且局部更新保留位置', () => {
    const store = createStore()
    store.set(updateChangesViewAtom, { key: 'a:main', patch: { scrollTop: 450, searchQuery: 'foo', collapsedDirs: new Set(['src']) } })
    store.set(updateChangesViewAtom, { key: 'b:main', patch: { scrollTop: 90 } })
    store.set(updateChangesViewAtom, { key: 'a:tree', patch: { scrollTop: 30 } })
    store.set(updateChangesViewAtom, { key: 'a:main', patch: { earlierExpanded: true } })
    expect(store.get(changesViewStatesAtom).get('a:main')).toMatchObject({ scrollTop: 450, searchQuery: 'foo', earlierExpanded: true })
    expect(store.get(changesViewStatesAtom).get('b:main')?.scrollTop).toBe(90)
    expect(store.get(changesViewStatesAtom).get('a:tree')?.scrollTop).toBe(30)
  })
  test('Given 多会话浏览 When 超过上限 Then 淘汰最旧状态但保留最近使用', () => {
    const store = createStore()
    for (let i = 0; i < 201; i++) store.set(updateChangesViewAtom, { key: String(i), patch: { scrollTop: i } })
    expect(store.get(changesViewStatesAtom).size).toBe(200)
    expect(store.get(changesViewStatesAtom).has('0')).toBe(false)
  })
})
