import { describe, expect, test } from 'bun:test'
import { buildPiToolFailureGuidance } from './pi-tool-failure-guidance'

describe('Pi 工具失败纠偏', () => {
  test('Given MultiEdit 精确匹配失败 When 生成纠偏 Then 要求重读后重试且禁止整文件覆盖', () => {
    const guidance = buildPiToolFailureGuidance('edit', true, [{
      type: 'text',
      text: 'Could not find edits[1] in E:\\电商\\产品\\1688\\index.html. The oldText must match exactly.',
    }])

    expect(guidance).toContain('重新 Read')
    expect(guidance).toContain('不要因为精确匹配失败而用 Write 覆盖整个已有文件')
  })

  test('Given 缺失 CLAUDE.md When Read 返回 ENOENT Then 要求跳过而非继续猜测路径', () => {
    const guidance = buildPiToolFailureGuidance('read', true, [{
      type: 'text',
      text: "ENOENT: no such file or directory, access 'C:\\workspace\\CLAUDE.md'",
    }])

    expect(guidance).toContain('跳过即可')
    expect(guidance).toContain('不要继续尝试 cwd')
  })

  test('Given 工具成功或其他错误 When 生成纠偏 Then 不追加无关提示', () => {
    expect(buildPiToolFailureGuidance('edit', false, [{ type: 'text', text: 'ok' }])).toBeUndefined()
    expect(buildPiToolFailureGuidance('read', true, [{ type: 'text', text: 'permission denied' }])).toBeUndefined()
  })
})
