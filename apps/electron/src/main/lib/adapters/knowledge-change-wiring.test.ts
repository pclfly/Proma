import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('知识变更接线', () => {
  test('Given Pi 内置工具 When 构建 Then 记忆/项目规则工具被追踪且注入项目地图工具', () => {
    const source = readFileSync(join(import.meta.dir, 'pi-builtin-tools.ts'), 'utf8')
    expect(source).toContain('wrapSynchronousKnowledgeTools')
    expect(source).toContain('buildProjectMapTools')
    expect(source).toContain('ctx.onKnowledgeChanges')
    expect(source).toContain('buildMemoryTools(sdk, restricted, { readOnly })')
    expect(source).toContain('buildInstructionMigrationTools(sdk, restricted, { readOnly })')
  })

  test('Given Agent 编排 When 知识工具写入 Then 发出 knowledge_changed 事件', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'agent-orchestrator.ts'),
      'utf8',
    )
    expect(source).toContain('onKnowledgeChanges: (changes)')
    expect(source).toContain("type: 'knowledge_changed'")
  })
})
