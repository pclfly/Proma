import { describe, expect, test } from 'bun:test'
import {
  buildWorkspaceKnowledgeRecoveryInstruction,
  formatWorkspaceKnowledgeFileState,
} from './agent-workspace-knowledge-prompt'

describe('工作区知识文件提示', () => {
  test('Given CLAUDE.md 不存在 When 构建状态 Then 明确跳过且不从 cwd 猜测', () => {
    const status = formatWorkspaceKnowledgeFileState({
      label: '工作区规则文件 CLAUDE.md',
      path: 'C:\\workspace\\CLAUDE.md',
      exists: false,
    })

    expect(status).toContain('当前不存在')
    expect(status).toContain('不要调用 Read 探测')
    expect(status).toContain('不要从 cwd 猜测')
  })

  test('Given 部分知识文件不存在 When 构建恢复指令 Then 只读取已存在文件的绝对路径', () => {
    const instruction = buildWorkspaceKnowledgeRecoveryInstruction([
      { label: '工作区规则文件 CLAUDE.md', path: 'C:\\workspace\\CLAUDE.md', exists: false },
      { label: 'Auto Memory 索引', path: 'C:\\workspace\\.claude\\memory\\MEMORY.md', exists: true },
    ])

    expect(instruction).toContain('仅在与当前任务相关时读取这些已存在文件的绝对路径')
    expect(instruction).toContain('C:\\workspace\\.claude\\memory\\MEMORY.md')
    expect(instruction).toContain('C:\\workspace\\CLAUDE.md')
    expect(instruction).toContain('跳过即可')
  })
})
