import { describe, expect, test } from 'bun:test'
import { splitProjectSessionPreview } from './project-session-preview'

const item = (id: string) => ({ session: { id } })
/** 模拟 buildAgentSessionTrees 的输出：已按活动时间倒序 */
const tree = (...ids: string[]) => ids.map(item)

describe('项目会话折叠基线', () => {
  test('Given 只有活跃会话 When 计算基线 Then 还要补足最近 5 个会话', () => {
    const items = tree('active', 's1', 's2', 's3', 's4', 's5', 's6')
    const { preview, remaining } = splitProjectSessionPreview(items, new Set(['active']), 5)

    expect(preview.map((i) => i.session.id)).toEqual(['s1', 's2', 's3', 's4', 's5'])
    expect(remaining.map((i) => i.session.id)).toEqual(['s6'])
  })

  test('Given 多个活跃会话 When 已是最近项 Then 不重复计入基线', () => {
    const items = tree('a1', 'a2', 's1', 's2')
    const { preview, remaining } = splitProjectSessionPreview(items, new Set(['a1', 'a2']), 5)

    expect(preview.map((i) => i.session.id)).toEqual(['s1', 's2'])
    expect(remaining).toEqual([])
  })

  test('Given 会话数不足基线 When 计算 Then 全部可见且无剩余', () => {
    const items = tree('s1', 's2')
    const { preview, remaining } = splitProjectSessionPreview(items, new Set(), 5)

    expect(preview).toHaveLength(2)
    expect(remaining).toHaveLength(0)
  })

  test('Given 委派子会话属于活跃树 When 计算 Then 子会话不重复出现在基线', () => {
    const items = tree('parent', 'child-of-other', 's1')
    const { preview } = splitProjectSessionPreview(items, new Set(['parent', 'child-of-other']), 5)

    expect(preview.map((i) => i.session.id)).toEqual(['s1'])
  })
})
