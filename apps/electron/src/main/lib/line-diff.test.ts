import { describe, expect, test } from 'bun:test'
import { diffTextLines, diffWordsInLine } from './line-diff'

describe('行级 diff', () => {
  test('Given 单行修改 When diff Then 生成一个 removed/added hunk', () => {
    const result = diffTextLines('a\nb\nc', 'a\nB\nc')
    expect(result.removedTotal).toBe(1)
    expect(result.addedTotal).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]?.context).toEqual(['a'])
    expect(result.hunks[0]?.removed).toEqual([{ line: 2, text: 'b' }])
    expect(result.hunks[0]?.added).toEqual([{ line: 2, text: 'B' }])
  })

  test('Given 新增文件 When diff Then 全部为 added', () => {
    const result = diffTextLines('', 'x\ny')
    expect(result.removedTotal).toBe(0)
    expect(result.addedTotal).toBe(2)
    expect(result.hunks[0]?.added.map((line) => line.text)).toEqual(['x', 'y'])
  })

  test('Given 删除文件 When diff Then 全部为 removed', () => {
    const result = diffTextLines('x\ny', '')
    expect(result.removedTotal).toBe(2)
    expect(result.addedTotal).toBe(0)
    expect(result.hunks[0]?.removed.map((line) => line.text)).toEqual(['x', 'y'])
  })

  test('Given 多个独立变更 When diff Then 最多三个 hunk 并标记 truncated', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line-${i}`)
    const after = [...before]
    // 每两个变更之间隔 2 行相等内容，超过 1 行上下文，因此会拆成独立 hunk。
    for (const index of [0, 3, 6, 9]) after[index] = `changed-${index}`
    const result = diffTextLines(before.join('\n'), after.join('\n'))
    expect(result.hunks).toHaveLength(3)
    expect(result.truncated).toBe(true)
    expect(result.removedTotal).toBe(4)
    expect(result.addedTotal).toBe(4)
  })

  test('Given 单侧超过八行 When diff Then 截断并保留总数', () => {
    const before = Array.from({ length: 12 }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: 12 }, (_, i) => `new-${i}`).join('\n')
    const result = diffTextLines(before, after)
    expect(result.hunks[0]?.removed).toHaveLength(8)
    expect(result.hunks[0]?.added).toHaveLength(8)
    expect(result.removedTotal).toBe(12)
    expect(result.addedTotal).toBe(12)
    expect(result.truncated).toBe(true)
  })

  test('Given 超过 LCS 单元格上限 When diff Then 退化为全删全增', () => {
    const before = Array.from({ length: 1001 }, (_, i) => `before-${i}`).join('\n')
    const after = Array.from({ length: 1001 }, (_, i) => `after-${i}`).join('\n')
    const result = diffTextLines(before, after)
    expect(result.removedTotal).toBe(1001)
    expect(result.addedTotal).toBe(1001)
    expect(result.hunks[0]?.removed).toHaveLength(8)
    expect(result.hunks[0]?.added).toHaveLength(8)
  })
})

describe('词级 diff', () => {
  test('Given 英文单词替换 When diff Then 只标记变化 token', () => {
    const result = diffWordsInLine('hello old world', 'hello new world')
    expect(result.removed.map((span) => 'hello old world'.slice(span.start, span.end))).toEqual(['old'])
    expect(result.added.map((span) => 'hello new world'.slice(span.start, span.end))).toEqual(['new'])
  })

  test('Given 中文单字变化 When diff Then 按字切分', () => {
    const result = diffWordsInLine('这是旧内容', '这是新内容')
    expect(result.removed.map((span) => '这是旧内容'.slice(span.start, span.end))).toEqual(['旧'])
    expect(result.added.map((span) => '这是新内容'.slice(span.start, span.end))).toEqual(['新'])
  })

  test('Given 相同文本 When diff Then 无 span', () => {
    expect(diffWordsInLine('same', 'same')).toEqual({ removed: [], added: [] })
  })
})
