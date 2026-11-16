import { describe, expect, test } from 'bun:test'
import {
  createComputerUseWindowSourceProbe,
  findComputerUseWindowSource,
  hasComputerUseWindowSource,
  isComputerUseWindowSourceId,
  parseComputerUseWindowSourceWindowId,
} from './computer-use-window-source'

const sources = [
  { id: 'screen:0:0', name: 'Entire screen' },
  { id: 'window:42:0', name: 'Editor' },
  { id: 'window:77:1', name: 'Browser' },
  { id: 'window:abc:0', name: 'Invalid' },
]

describe('Computer Use 窗口源 ID', () => {
  test('Given 合法窗口源 When 校验 Then true', () => {
    expect(isComputerUseWindowSourceId('window:0:0')).toBe(true)
    expect(isComputerUseWindowSourceId('window:12345:1')).toBe(true)
  })

  test('Given 屏幕/不完整/非数字源 When 校验 Then false', () => {
    expect(isComputerUseWindowSourceId('screen:0:0')).toBe(false)
    expect(isComputerUseWindowSourceId('window:12345')).toBe(false)
    expect(isComputerUseWindowSourceId('window:abc:0')).toBe(false)
    expect(isComputerUseWindowSourceId('window:12:2')).toBe(false)
  })

  test('Given 合法窗口源 When 解析 windowId Then 返回数字', () => {
    expect(parseComputerUseWindowSourceWindowId('window:42:0')).toBe(42)
    expect(parseComputerUseWindowSourceWindowId('window:42:1')).toBe(42)
  })

  test('Given 非窗口源 When 解析 windowId Then undefined', () => {
    expect(parseComputerUseWindowSourceWindowId('screen:0:0')).toBeUndefined()
    expect(parseComputerUseWindowSourceWindowId('window:abc:0')).toBeUndefined()
  })
})

describe('Computer Use 窗口源选择', () => {
  test('Given 多个窗口源 When 按 windowId 查找 Then 命中对应窗口', () => {
    expect(findComputerUseWindowSource(sources, 77)?.name).toBe('Browser')
    expect(findComputerUseWindowSource(sources, 42)?.id).toBe('window:42:0')
  })

  test('Given 只有屏幕源 When 查找窗口 Then 不误命中屏幕', () => {
    expect(findComputerUseWindowSource([{ id: 'screen:0:0' }], 0)).toBeUndefined()
    expect(hasComputerUseWindowSource(sources, 999)).toBe(false)
  })

  test('Given 注入 source 枚举 When 探测 Then 返回窗口是否存在', async () => {
    let calls = 0
    const probe = createComputerUseWindowSourceProbe(async () => {
      calls += 1
      return sources
    })
    expect(await probe.hasWindow(77)).toBe(true)
    expect(await probe.hasWindow(9)).toBe(false)
    expect(calls).toBe(2)
  })
})
