import { describe, expect, test } from 'bun:test'
import { canExpandToolDetails } from './tool-expansion-state'

describe('工具详情展开条件', () => {
  test.each([undefined, '', 'error: failed', 'output'])('Given Bash运行中或已有结果 %s When 展开 Then 完整命令均可展示', (result) => {
    expect(canExpandToolDetails('Bash', { command: 'echo first\necho second' }, result)).toBe(true)
  })
  test('Given 空命令或非Bash工具且无结果 When 检查 Then 不制造空详情', () => {
    expect(canExpandToolDetails('Bash', { command: '  ' }, undefined)).toBe(false)
    expect(canExpandToolDetails('Read', { command: 'not bash' }, undefined)).toBe(false)
    expect(canExpandToolDetails('Read', {}, 'file contents')).toBe(true)
  })
})
