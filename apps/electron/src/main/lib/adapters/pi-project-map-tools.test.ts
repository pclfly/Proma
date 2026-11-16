import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { memoryAssociation, type AgentMemoryContext } from '../agent-memory'
import { readProjectMapReviewState } from '../project-map-review'
import { buildProjectMapTools } from './pi-project-map-tools'

interface TestTool {
  name: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }>
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'proma-project-map-'))
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(join(workspaceRoot, 'memory'), { recursive: true })
  mkdirSync(join(root, 'global'), { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  const agentsFile = join(projectRoot, 'AGENTS.md')
  writeFileSync(agentsFile, `# 项目\n\n${'规则'.repeat(120)}\n`)
  return { root, workspaceRoot, projectRoot, agentsFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function toolsFor(workspaceRoot: string, projectRoot: string, memoryContext?: AgentMemoryContext): TestTool[] {
  const sdk = { defineTool: (tool: TestTool) => tool } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return buildProjectMapTools(sdk, workspaceRoot, projectRoot, memoryContext) as unknown as TestTool[]
}

describe('项目地图工具', () => {
  test('Given 未先 Inspect When ReviewComplete Then 拒绝记录', async () => {
    const fixture = createFixture()
    try {
      const tools = toolsFor(fixture.workspaceRoot, fixture.projectRoot)
      const complete = tools.find((tool) => tool.name === 'ProjectMapReviewComplete')!
      await expect(complete.execute('call', {
        revision: 'a'.repeat(64),
        summary: '核验',
      })).rejects.toThrow('请先使用 ProjectMapInspect')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 文件在 Inspect 后变化 When ReviewComplete Then 拒绝旧 revision', async () => {
    const fixture = createFixture()
    try {
      const tools = toolsFor(fixture.workspaceRoot, fixture.projectRoot)
      const inspect = tools.find((tool) => tool.name === 'ProjectMapInspect')!
      const complete = tools.find((tool) => tool.name === 'ProjectMapReviewComplete')!
      const inspected = JSON.parse((await inspect.execute('inspect', {})).content[0]!.text) as {
        revision: string
      }
      appendFileSync(fixture.agentsFile, '\n补充\n')
      await expect(complete.execute('complete', {
        revision: inspected.revision,
        summary: '核验',
      })).rejects.toThrow('AGENTS.md 已发生变化')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 复核后 revision 匹配 When ReviewComplete Then 写检查记录并可读回', async () => {
    const fixture = createFixture()
    try {
      const tools = toolsFor(fixture.workspaceRoot, fixture.projectRoot)
      const inspect = tools.find((tool) => tool.name === 'ProjectMapInspect')!
      const complete = tools.find((tool) => tool.name === 'ProjectMapReviewComplete')!
      const inspected = JSON.parse((await inspect.execute('inspect', {})).content[0]!.text) as {
        revision: string
      }
      const result = JSON.parse((await complete.execute('complete', {
        revision: inspected.revision,
        summary: '  已核对目录和命令  ',
      })).content[0]!.text) as { checkedAt: number; revision: string; summary: string }
      expect(result).toMatchObject({
        revision: inspected.revision,
        summary: '已核对目录和命令',
      })
      const state = readProjectMapReviewState(fixture.workspaceRoot, fixture.projectRoot)
      expect(state.checkedAt).toBe(result.checkedAt)
      expect(state.reviewDue).toBe(false)
      expect(() => readFileSync(fixture.agentsFile, 'utf8')).not.toThrow()
      // 完成后必须重新 Inspect 才能再次确认。
      await expect(complete.execute('complete-again', {
        revision: inspected.revision,
        summary: '再次确认',
      })).rejects.toThrow('请先使用 ProjectMapInspect')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 缺少记忆关联 When ReviewComplete Then 要求先 MemoryInitialize', async () => {
    const fixture = createFixture()
    try {
      const ctx: AgentMemoryContext = {
        globalDir: join(fixture.root, 'global'),
        workspaceRoot: fixture.workspaceRoot,
        projectRoot: fixture.projectRoot,
        workspaces: [],
      }
      const tools = toolsFor(fixture.workspaceRoot, fixture.projectRoot, ctx)
      const inspect = tools.find((tool) => tool.name === 'ProjectMapInspect')!
      const complete = tools.find((tool) => tool.name === 'ProjectMapReviewComplete')!
      const inspected = JSON.parse((await inspect.execute('inspect', {})).content[0]!.text) as {
        revision: string
      }
      await expect(complete.execute('complete', {
        revision: inspected.revision,
        summary: '核验',
      })).rejects.toThrow('MemoryInitialize')

      writeFileSync(fixture.agentsFile, `# 项目\n\n${'规则'.repeat(120)}\n\n${memoryAssociation(ctx)}\n`)
      const refreshed = JSON.parse((await inspect.execute('inspect-2', {})).content[0]!.text) as {
        revision: string
      }
      await expect(complete.execute('complete-2', {
        revision: refreshed.revision,
        summary: '已核验记忆方案',
      })).resolves.toBeDefined()
    } finally {
      fixture.cleanup()
    }
  })
})
