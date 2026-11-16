import { describe, expect, test } from 'bun:test'
import { shouldMarquee } from '../components/ui/marquee-text'

describe('侧栏标题跑马灯判定', () => {
  test('Given 文本超出容器 When 判定 Then 悬停时滚动', () => {
    expect(shouldMarquee(240, 120)).toBe(true)
  })

  test('Given 文本未超出或容器不可测 When 判定 Then 不滚动', () => {
    expect(shouldMarquee(120, 240)).toBe(false)
    expect(shouldMarquee(120, 0)).toBe(false)
    expect(shouldMarquee(Number.NaN, 120)).toBe(false)
  })
})
