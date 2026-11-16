import { describe, expect, test } from 'bun:test'
import { COMPACT_SHELL_BREAKPOINT, resolveShellLayoutMode } from './layout-mode'

describe('紧凑单栏布局判定', () => {
  test('Given 窗口宽度不超过断点 When 判定 Then 使用紧凑单栏', () => {
    expect(resolveShellLayoutMode(COMPACT_SHELL_BREAKPOINT)).toBe('compact')
    expect(resolveShellLayoutMode(480)).toBe('compact')
  })

  test('Given 桌面宽度 When 判定 Then 保持桌面布局', () => {
    expect(resolveShellLayoutMode(COMPACT_SHELL_BREAKPOINT + 1)).toBe('desktop')
    expect(resolveShellLayoutMode(1280)).toBe('desktop')
  })

  test('Given 非法宽度 When 判定 Then 回退桌面布局', () => {
    expect(resolveShellLayoutMode(Number.NaN)).toBe('desktop')
  })
})
