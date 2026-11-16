import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMemoryContext } from './agent-memory'
import {
  readInstructionReadyRecord,
  writeInstructionReadyRecord,
} from './project-instruction-state'
import {
  inspectInstructionMigration,
  mergeProjectInstructions,
} from './project-instruction-memory-migration'
import { maintainProjectInstructions } from './project-instruction-maintenance'
import { buildInstructionMigrationTools } from './adapters/pi-instruction-migration-tools'

function setup(options: { projectAgents?: string; outerAgents?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'proma-instructions-'))
  const globalDir = join(root, 'global')
  const workspaceRoot = join(root, 'agent-workspaces', 'demo')
  const projectRoot = join(root, 'project')
  mkdirSync(join(workspaceRoot, 'memory'), { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  writeFileSync(join(globalDir, 'user_profile.md'), '# Profile\n\n- 用户偏好中文', 'utf8')
  writeFileSync(join(workspaceRoot, 'memory', 'MEMORY.md'), '# Memory\n\n- [主题](topic.md)', 'utf8')
  writeFileSync(join(workspaceRoot, 'memory', 'topic.md'), '# Topic\n\n- fact', 'utf8')
  if (options.projectAgents !== undefined) {
    writeFileSync(join(projectRoot, 'AGENTS.md'), options.projectAgents, 'utf8')
  }
  if (options.outerAgents !== undefined) {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), options.outerAgents, 'utf8')
  }
  const ctx: AgentMemoryContext = {
    globalDir,
    workspaceRoot,
    projectRoot,
    workspaces: [{ slug: 'demo', root: workspaceRoot }],
  }
  return { root, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('项目规则维护完成记录', () => {
  test('Given 目标与记忆均就绪 When 写入 Then 可读回；目标改动后失效', () => {
    const { ctx, root, cleanup } = setup({ projectAgents: '# Project\n\nrule' })
    try {
      const record = writeInstructionReadyRecord(ctx, join(root, 'project', 'AGENTS.md'), true)
      expect(record.changed).toBe(true)
      expect(readInstructionReadyRecord(ctx)?.targetPath).toBe(record.targetPath)

      writeFileSync(join(root, 'project', 'AGENTS.md'), '# changed', 'utf8')
      expect(readInstructionReadyRecord(ctx)).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})

describe('项目规则迁移', () => {
  test('Given 项目入口与外层旧规则 When 合并 Then 项目文件更新且外层归档', () => {
    const { ctx, root, cleanup } = setup({
      projectAgents: '# Project\n\n- project rule',
      outerAgents: '# Outer\n\n- old rule',
    })
    try {
      const state = inspectInstructionMigration(ctx)
      expect(state.sources).toHaveLength(1)
      const id = mergeProjectInstructions(ctx, {
        targetRevision: state.target.revision,
        sources: state.sources.map((source) => ({ path: source.path, revision: source.revision })),
        content: '# Project\n\n- project rule\n- old rule',
        summary: '合并并去重',
      })
      expect(id).toHaveLength(36)
      expect(readFileSync(join(root, 'project', 'AGENTS.md'), 'utf8')).toContain('- old rule')
      expect(existsSync(join(root, 'agent-workspaces', 'demo', 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(root, 'agent-workspaces', 'demo', 'instruction-migrations', id, 'completed.json'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('Given target revision 过期 When 合并 Then 拒绝覆盖', () => {
    const { ctx, cleanup } = setup({
      projectAgents: '# Project',
      outerAgents: '# Outer',
    })
    try {
      const state = inspectInstructionMigration(ctx)
      expect(() => mergeProjectInstructions(ctx, {
        targetRevision: '0'.repeat(64),
        sources: state.sources.map((source) => ({ path: source.path, revision: source.revision })),
        content: '# merged',
        summary: 'merge',
      })).toThrow('变化')
    } finally {
      cleanup()
    }
  })
})

describe('项目能力维护', () => {
  test('Given 无可迁移来源 When Maintain Then 建立关联并记录 ready', () => {
    const { ctx, cleanup } = setup({ projectAgents: '# Project\n\n- rule' })
    try {
      const result = maintainProjectInstructions(ctx)
      expect(result.status).toBe('ready')
      expect(result.changed).toBe(true)
      expect(readInstructionReadyRecord(ctx)).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('Given 项目与外层实质冲突 When Maintain Then needs-merge', () => {
    const { ctx, cleanup } = setup({
      projectAgents: '# Project\n\n- rule A',
      outerAgents: '# Outer\n\n- rule B',
    })
    try {
      const result = maintainProjectInstructions(ctx)
      expect(result.status).toBe('needs-merge')
      expect(result.sources).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('Given readOnly When 构建工具 Then 只暴露 Inspect', () => {
    const { ctx, cleanup } = setup({ projectAgents: '# Project' })
    try {
      const sdk = {
        defineTool: (tool: { name: string }) => tool,
      } as unknown as typeof import('@earendil-works/pi-coding-agent')
      const tools = buildInstructionMigrationTools(sdk, {
        ...ctx,
        allowProfileMigration: false,
        allowInstructionMaintenance: false,
      }, { readOnly: true })
      expect(tools.map((tool) => tool.name)).toEqual(['ProjectInstructionsInspect'])
    } finally {
      cleanup()
    }
  })
})
