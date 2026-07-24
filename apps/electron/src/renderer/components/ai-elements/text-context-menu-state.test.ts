import { describe, expect, test } from 'bun:test'
import { hasCopyableSelection, resolveEditableTextMenuState } from './text-context-menu-state'

describe('文本右键菜单状态', () => {
  test('Given 可编辑输入框且已有选区 When 解析菜单状态 Then 开放剪切复制和粘贴', () => {
    const state = resolveEditableTextMenuState({
      editable: true,
      hasSelection: true,
      canUndo: true,
      canRedo: false,
      clipboardReadSupported: true,
    })

    expect(state).toEqual({
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
    })
  })

  test('Given 只读输入框且已有选区 When 解析菜单状态 Then 仅保留复制能力', () => {
    const state = resolveEditableTextMenuState({
      editable: false,
      hasSelection: true,
      canUndo: true,
      canRedo: true,
      clipboardReadSupported: true,
    })

    expect(state).toEqual({
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
    })
  })

  test('Given 对话页存在文本选区 When 判断复制能力 Then 只按真实选区内容启用', () => {
    expect(hasCopyableSelection('选中的消息')).toBe(true)
    expect(hasCopyableSelection('')).toBe(false)
  })
})
