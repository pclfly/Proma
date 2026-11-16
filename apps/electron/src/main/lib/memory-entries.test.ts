import { describe, expect, test } from 'bun:test'
import { applyMemoryEntryOperations } from './memory-entries'

describe('记忆条目操作', () => {
  test('Given 空条目列表 When 操作 Then 拒绝', () => {
    expect(() => applyMemoryEntryOperations('', [])).toThrow('至少一条')
  })

  test('Given 新条目 When add Then 追加到末尾并生成单行 bullet', () => {
    const result = applyMemoryEntryOperations('# Memory\n\n- existing', [{ op: 'add', entry: '新的偏好' }])
    expect(result.content).toBe('# Memory\n\n- existing\n- 新的偏好')
    expect(result.changes).toEqual([{ op: 'add', entry: '- 新的偏好' }])
  })

  test('Given 重复条目 When add Then 跳过而不是重复写入', () => {
    const result = applyMemoryEntryOperations('- 用户偏好中文回复', [{ op: 'add', entry: '用户偏好中文回复。' }])
    expect(result.changes).toEqual([])
    expect(result.skipped).toEqual([{ op: 'add', reason: 'duplicate', entry: '- 用户偏好中文回复。' }])
  })

  test('Given after 锚点 When add Then 插入锚点之后', () => {
    const result = applyMemoryEntryOperations('- a\n- b\n- c', [{ op: 'add', entry: 'x', after: 'a' }])
    expect(result.content).toBe('- a\n- x\n- b\n- c')
  })

  test('Given update/remove When 唯一定位 Then 替换或删除', () => {
    const updated = applyMemoryEntryOperations('- a\n- b', [{ op: 'update', match: 'a', entry: 'A' }])
    expect(updated.content).toBe('- A\n- b')
    const removed = applyMemoryEntryOperations('- a\n- b', [{ op: 'remove', match: 'b' }])
    expect(removed.content).toBe('- a')
  })

  test('Given 多条命中 When update Then 拒绝猜测', () => {
    expect(() => applyMemoryEntryOperations('- same\n- same', [{ op: 'update', match: 'same', entry: 'x' }]))
      .toThrow('无法唯一定位')
  })

  test('Given 找不到 When update Then 记录 skipped', () => {
    const result = applyMemoryEntryOperations('- a', [{ op: 'update', match: 'missing', entry: 'x' }])
    expect(result.changes).toEqual([])
    expect(result.skipped[0]).toMatchObject({ reason: 'not-found' })
  })

  test('Given 多行或空条目 When add Then 拒绝', () => {
    expect(() => applyMemoryEntryOperations('', [{ op: 'add', entry: 'a\nb' }])).toThrow('单行条目')
    expect(() => applyMemoryEntryOperations('', [{ op: 'add', entry: '  ' }])).toThrow('不能为空')
  })
})
