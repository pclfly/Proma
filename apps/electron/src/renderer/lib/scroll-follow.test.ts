import { describe, expect, test } from 'bun:test'
import { shouldStopScrollFollow, shouldStopScrollFollowOnTouch } from './scroll-follow'

describe('滚动跟随停止判定', () => {
  test('Given 滚轮向上 When 判定 Then 立即停止跟随', () => {
    expect(shouldStopScrollFollow(-1)).toBe(true)
    expect(shouldStopScrollFollow(-120)).toBe(true)
  })

  test('Given 滚轮向下或为零 When 判定 Then 不改变跟随状态', () => {
    expect(shouldStopScrollFollow(1)).toBe(false)
    expect(shouldStopScrollFollow(0)).toBe(false)
    expect(shouldStopScrollFollow(Number.NaN)).toBe(false)
  })

  test('Given 手指上滑 When 判定 Then 停止跟随；手指下滑不停止', () => {
    expect(shouldStopScrollFollowOnTouch(320, 280)).toBe(true)
    expect(shouldStopScrollFollowOnTouch(280, 320)).toBe(false)
    expect(shouldStopScrollFollowOnTouch(280, 280)).toBe(false)
  })
})
