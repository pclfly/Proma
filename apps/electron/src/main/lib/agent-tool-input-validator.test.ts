import { describe, expect, test } from 'bun:test'
import { validateToolInput } from './agent-tool-input-validator'
import { normalizePermissionInput, displayToolName } from './adapters/pi-message-adapter'

describe('Pi工具输入贯通权限校验', () => {
  const edit = (edits: unknown[]) => {
    const input = { path: 'fixture.ts', edits }
    return validateToolInput(displayToolName('edit', input), normalizePermissionInput('edit', input))
  }
  test('Given 原生删除或空文件 When 权限校验 Then 允许空新文本与空content', () => {
    expect(edit([{ oldText: 'remove', newText: '' }])).toBeNull()
    expect(validateToolInput('Write', normalizePermissionInput('write', { path: 'empty.txt', content: '' }))).toBeNull()
  })
  test('Given 空旧锚点或第二项缺字段 When 校验 Then 报原生索引而非old_string', () => {
    expect(edit([{ oldText: '', newText: 'x' }])?.message).toContain('edits[0].oldText')
    expect(edit([{ oldText: 'a', newText: 'b' }, { oldText: 'c' }])?.message).toContain('edits[1].newText')
    expect(edit([])?.message).toContain('edits')
  })
  test('Given 非字符串字段 When 校验 Then 拒绝而不是强制转换', () => {
    expect(edit([{ oldText: 1, newText: 'x' }])?.behavior).toBe('deny')
    expect(validateToolInput('Write', { file_path: 'a', content: 5 })?.behavior).toBe('deny')
  })
  test('Given 兼容别名与普通工具 When 校验 Then 合法删除通过且必要参数仍检查', () => {
    expect(validateToolInput('Edit', { file_path: 'a', old_string: 'x', new_string: '' })).toBeNull()
    expect(validateToolInput('Bash', { command: '' })?.behavior).toBe('deny')
    expect(validateToolInput('Unrelated', {})).toBeNull()
  })
})
