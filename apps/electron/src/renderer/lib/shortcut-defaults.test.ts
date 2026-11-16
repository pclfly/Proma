import { describe, expect, test } from 'bun:test'
import { DEFAULT_SHORTCUTS } from './shortcut-defaults'

describe('界面缩放入口（0.22.60 移除）', () => {
  test('Given 官方移除应用内界面缩放 When 读取默认快捷键 Then 不再暴露缩放项', () => {
    // 保留正文/代码/终端分轴字号；整体界面缩放不再作为应用快捷键出现。
    for (const id of ['zoom-in', 'zoom-out', 'reset-zoom']) {
      expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === id)).toBeUndefined()
    }
  })
})
