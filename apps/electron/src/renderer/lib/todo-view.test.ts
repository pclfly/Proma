import { describe, expect, test } from 'bun:test'
import { getReorderedGroupSortOrder } from './todo-view'

const groups = [
  { id: 'a', name: 'A', sortOrder: 1 },
  { id: 'b', name: 'B', sortOrder: 2 },
  { id: 'c', name: 'C', sortOrder: 3 },
]

describe('Todo 分组排序', () => {
  test('Given 中间分组 When 上移 Then 落在相邻两组之间', () => {
    expect(getReorderedGroupSortOrder(groups, 'c', 'up')).toBe(1.5)
  })

  test('Given 中间分组 When 下移 Then 落在相邻两组之间', () => {
    expect(getReorderedGroupSortOrder(groups, 'a', 'down')).toBe(2.5)
  })

  test('Given 第二组 When 上移 Then 直接排到首组之前', () => {
    expect(getReorderedGroupSortOrder(groups, 'b', 'up')).toBe(0)
  })

  test('Given 首组 When 上移 Then 已到边界不移动', () => {
    expect(getReorderedGroupSortOrder(groups, 'a', 'up')).toBeUndefined()
  })

  test('Given 末组 When 下移 Then 已到边界不移动', () => {
    expect(getReorderedGroupSortOrder(groups, 'c', 'down')).toBeUndefined()
  })

  test('Given 分组不存在 When 排序 Then 返回 undefined', () => {
    expect(getReorderedGroupSortOrder(groups, 'missing', 'up')).toBeUndefined()
  })

  test('Given 输入顺序混乱 When 排序 Then 先按 sortOrder/名称归一化再计算', () => {
    const shuffled = [
      { id: 'c', name: 'C', sortOrder: 3 },
      { id: 'a', name: 'A', sortOrder: 1 },
      { id: 'b', name: 'B', sortOrder: 2 },
    ]
    expect(getReorderedGroupSortOrder(shuffled, 'b', 'up')).toBe(0)
  })
})
