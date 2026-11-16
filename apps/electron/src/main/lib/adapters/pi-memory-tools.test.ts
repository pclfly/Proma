import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { ensureMemoryFiles, memoryPaths, readMemoryFile, type AgentMemoryContext } from '../agent-memory'
import { buildMemoryTools, MEMORY_TOOL_NAMES } from './pi-memory-tools'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

interface ToolFixture {
  root: string
  ctx: AgentMemoryContext
  context: ExtensionToolContext
  cleanup: () => void
}

function createFixture(): ToolFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-memory-tools-'))
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  const ctx: AgentMemoryContext = {
    globalDir: join(root, 'global'),
    workspaceRoot,
    projectRoot,
    canonicalProjectRoot: projectRoot,
    workspaces: [{ slug: 'demo', root: workspaceRoot }],
    allowProfileMigration: true,
    allowInstructionMaintenance: true,
    allowMemoryWrites: true,
  }
  return {
    root,
    ctx,
    context: { cwd: projectRoot } as ExtensionToolContext,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function fakeSdk(): PiSdk {
  return { defineTool: (tool: unknown) => tool } as unknown as PiSdk
}

function toolByName(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`缺少工具: ${name}`)
  return tool
}

async function callTool(
  fixture: ToolFixture,
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  return tool.execute('call', params, undefined, undefined, fixture.context)
}

function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
  return result.details as Record<string, unknown>
}

describe('Agent Memory 工具', () => {
  test('Given 可写工作区 When 构建工具 Then 暴露完整记忆面', () => {
    const fixture = createFixture()
    try {
      const tools = buildMemoryTools(fakeSdk(), fixture.ctx)
      expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_TOOL_NAMES])
      expect(tools.map((tool) => tool.name)).toContain('MemoryMigrateProfile')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 只读模式 When 构建工具 Then 只保留读取/检索/历史', () => {
    const fixture = createFixture()
    try {
      const tools = buildMemoryTools(fakeSdk(), fixture.ctx, { readOnly: true })
      expect(tools.map((tool) => tool.name)).toEqual(['MemoryInspect', 'MemorySearch', 'MemoryHistory'])
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 禁止画像迁移 When 构建工具 Then 不暴露 MemoryMigrateProfile', () => {
    const fixture = createFixture()
    try {
      const tools = buildMemoryTools(fakeSdk(), { ...fixture.ctx, allowProfileMigration: false })
      expect(tools.map((tool) => tool.name)).not.toContain('MemoryMigrateProfile')
      expect(tools.map((tool) => tool.name)).toContain('MemoryUpdate')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 新工作区 When 初始化、写入、检索 Then 工具链完整可用', async () => {
    const fixture = createFixture()
    try {
      const tools = buildMemoryTools(fakeSdk(), fixture.ctx)
      const initialized = await callTool(fixture, toolByName(tools, 'MemoryInitialize'), {})
      const initializedDetails = detailsOf(initialized)
      expect(initializedDetails.profile).toBe(memoryPaths(fixture.ctx).profile)
      expect(existsSync(memoryPaths(fixture.ctx).index)).toBe(true)

      const inspected = await callTool(fixture, toolByName(tools, 'MemoryInspect'), { target: 'global-profile' })
      const inspectDetails = detailsOf(inspected)
      expect(inspectDetails.revision).toBe(readMemoryFile(memoryPaths(fixture.ctx).profile).revision)
      expect((inspectDetails.budget as { maxChars: number }).maxChars).toBe(5_000)

      const indexRevision = readMemoryFile(memoryPaths(fixture.ctx).index).revision
      const updated = await callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'MEMORY.md',
        revision: indexRevision,
        operations: [{ op: 'add', entry: '[foo](foo.md) — 工具入口' }],
        summary: '工具写入测试',
      })
      const updateDetails = detailsOf(updated)
      expect((updateDetails.changes as unknown[]).length).toBe(1)
      expect(String(updateDetails.content)).toContain('foo.md')

      const duplicate = await callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'MEMORY.md',
        revision: String(updateDetails.revision),
        operations: [{ op: 'add', entry: '[foo](foo.md) — 工具入口' }],
        summary: '重复测试',
      })
      const duplicateDetails = detailsOf(duplicate)
      expect((duplicateDetails.changes as unknown[]).length).toBe(0)
      expect((duplicateDetails.skipped as Array<{ reason?: string }>)[0]?.reason).toBe('duplicate')

      await expect(callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'MEMORY.md',
        revision: indexRevision,
        content: '# 过期写入\n',
        summary: '旧 revision',
      })).rejects.toThrow('记忆已被其他会话修改')

      await expect(callTool(fixture, toolByName(tools, 'MemorySearch'), { query: '   ' }))
        .rejects.toThrow('关键词')
      const searched = await callTool(fixture, toolByName(tools, 'MemorySearch'), { query: 'foo' })
      const searchDetails = detailsOf(searched)
      expect((searchDetails.hits as unknown[]).length).toBeGreaterThan(0)

      const history = await callTool(fixture, toolByName(tools, 'MemoryHistory'), { target: 'MEMORY.md' })
      const historyDetails = detailsOf(history)
      expect((historyDetails.versions as unknown[]).length).toBeGreaterThan(0)

      await expect(callTool(fixture, toolByName(tools, 'MemoryMigrateProfile'), {}))
        .rejects.toThrow('proposal')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 项目偏好主题 When 归档 Then 工具返回 archive 路径', async () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const tools = buildMemoryTools(fakeSdk(), fixture.ctx)
      const index = readMemoryFile(memoryPaths(fixture.ctx).index)
      const indexed = await callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'MEMORY.md',
        revision: index.revision,
        content: '# 项目记忆索引\n\n## 主题\n\n- [prefs](project-preferences.md) — 偏好\n',
        summary: '建立偏好入口',
      })
      const indexedDetails = detailsOf(indexed)
      const topic = await callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'project-preferences.md',
        revision: 'a'.repeat(64),
        content: null,
        summary: '占位',
      }).catch((error: unknown) => error)
      expect(topic).toBeInstanceOf(Error)
      expect(String(topic)).toContain('content 或至少一条条目操作')

      const created = await callTool(fixture, toolByName(tools, 'MemoryUpdate'), {
        target: 'project-preferences.md',
        revision: readMemoryFile(memoryPaths(fixture.ctx).preferences).revision,
        content: '# 项目偏好\n\n- 使用 pnpm\n',
        summary: '创建偏好',
      })
      const createdDetails = detailsOf(created)
      const archived = await callTool(fixture, toolByName(tools, 'MemoryArchive'), {
        target: 'project-preferences.md',
        revision: String(createdDetails.revision),
        indexRevision: String(indexedDetails.revision),
        indexContent: '# 项目记忆索引\n\n## 主题\n\n暂无。\n',
      })
      expect(String(detailsOf(archived).archive)).toContain('project-preferences.md')
    } finally {
      fixture.cleanup()
    }
  })
})
