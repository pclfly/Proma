import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TrackedKnowledgeChange } from '@proma/shared'
import type { AgentMemoryContext } from './agent-memory'
import { createKnowledgeChangeTracker, resolveKnowledgeToolPath } from './knowledge-change-tracker'
import { wrapSynchronousKnowledgeTools } from './adapters/pi-knowledge-change-tools'

interface Fixture {
  root: string
  ctx: AgentMemoryContext
  memoryFile: string
  agentsFile: string
  changes: TrackedKnowledgeChange[]
  cleanup: () => void
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-knowledge-'))
  const globalDir = join(root, 'global')
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(join(globalDir, 'history'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'memory'), { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  const memoryFile = join(workspaceRoot, 'memory', 'topic.md')
  const agentsFile = join(projectRoot, 'AGENTS.md')
  writeFileSync(memoryFile, 'old\n')
  writeFileSync(agentsFile, '# 项目\n')
  const changes: TrackedKnowledgeChange[] = []
  return {
    root,
    ctx: {
      globalDir,
      workspaceRoot,
      projectRoot,
      workspaces: [],
      allowProfileMigration: true,
    },
    memoryFile,
    agentsFile,
    changes,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('知识变更追踪器', () => {
  test('Given MemoryUpdate 真实修改 When runSynchronous Then 只产生一次 modified 记录', () => {
    const fixture = createFixture()
    try {
      const tracker = createKnowledgeChangeTracker({
        memoryContext: fixture.ctx,
        cwd: fixture.ctx.projectRoot,
        onChanges: (changes) => fixture.changes.push(...changes),
      })
      tracker.runSynchronous('MemoryUpdate', { target: 'topic.md' }, () => {
        writeFileSync(fixture.memoryFile, 'new\n')
      })
      expect(fixture.changes).toHaveLength(1)
      expect(fixture.changes[0]).toMatchObject({
        relativePath: '项目记忆/topic.md',
        absolutePath: fixture.memoryFile,
        kind: 'modified',
        diffAvailable: true,
        preview: 'new',
      })
      expect(fixture.changes[0]?.diff?.added).toEqual(['new'])
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 内容未变 When 工具返回 Then 不产生变更记录', () => {
    const fixture = createFixture()
    try {
      const tracker = createKnowledgeChangeTracker({
        memoryContext: fixture.ctx,
        cwd: fixture.ctx.projectRoot,
        onChanges: (changes) => fixture.changes.push(...changes),
      })
      tracker.runSynchronous('MemoryUpdate', { target: 'topic.md' }, () => undefined)
      expect(fixture.changes).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given write 工具修改 AGENTS.md When 包装执行 Then 分类为项目规则并保留绝对路径', async () => {
    const fixture = createFixture()
    try {
      const tool = {
        name: 'write',
        label: 'write',
        description: 'fixture',
        parameters: {},
        async execute(_id: string, params: unknown) {
          const args = params as { path: string }
          writeFileSync(args.path, '# 更新\n')
          return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
        },
      } as unknown as ToolDefinition
      const wrapped = wrapSynchronousKnowledgeTools(
        [tool],
        fixture.ctx,
        (changes) => fixture.changes.push(...changes),
      )
      await wrapped[0]!.execute(
        'call',
        { path: fixture.agentsFile } as never,
        undefined,
        undefined,
        undefined as never,
      )
      expect(fixture.changes[0]).toMatchObject({
        relativePath: '项目规则/AGENTS.md',
        absolutePath: realpathSync.native(fixture.agentsFile),
        kind: 'modified',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('Given shell 重定向 When 命令中包含绝对 md 路径 Then 追踪真实写入', () => {
    const fixture = createFixture()
    try {
      const tracker = createKnowledgeChangeTracker({
        memoryContext: fixture.ctx,
        cwd: fixture.ctx.projectRoot,
        onChanges: (changes) => fixture.changes.push(...changes),
      })
      tracker.runSynchronous(
        'bash',
        { command: `printf 'next\\n' >> "${fixture.memoryFile}"` },
        () => writeFileSync(fixture.memoryFile, 'next\n'),
      )
      expect(fixture.changes).toHaveLength(1)
      expect(fixture.changes[0]?.kind).toBe('modified')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 隐藏/归档记忆路径 When classify Then 拒绝，不泄漏内部目录', () => {
    const fixture = createFixture()
    try {
      const tracker = createKnowledgeChangeTracker({
        memoryContext: fixture.ctx,
        cwd: fixture.ctx.projectRoot,
        onChanges: () => undefined,
      })
      expect(tracker.classify(join(fixture.ctx.workspaceRoot, 'memory', '.archive', 'x.md')))
        .toBeUndefined()
      expect(tracker.classify(join(fixture.ctx.workspaceRoot, 'memory', 'archive', 'x.md')))
        .toBeUndefined()
      expect(tracker.classify(join(fixture.ctx.workspaceRoot, 'memory', 'topic.md')))
        .toMatchObject({ label: '项目记忆/topic.md' })
    } finally {
      fixture.cleanup()
    }
  })

  test('Given write 工具抛错 When 非 shell Then 不回调；shell 抛错仍结算副作用', async () => {
    const fixture = createFixture()
    try {
      const tracker = createKnowledgeChangeTracker({
        memoryContext: fixture.ctx,
        cwd: fixture.ctx.projectRoot,
        onChanges: (changes) => fixture.changes.push(...changes),
      })
      await expect(tracker.run('write', { path: fixture.agentsFile }, async () => {
        writeFileSync(fixture.agentsFile, '# 半写\n')
        throw new Error('write failed')
      })).rejects.toThrow('write failed')
      expect(fixture.changes).toHaveLength(0)

      await expect(tracker.run('bash', {
        command: `printf 'shell\\n' >> "${fixture.memoryFile}"`,
      }, async () => {
        writeFileSync(fixture.memoryFile, 'shell\n')
        throw new Error('shell failed')
      })).rejects.toThrow('shell failed')
      expect(fixture.changes).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given Windows 风格路径 When 解析 Then 展平盘符并处理 @/~', () => {
    if (process.platform !== 'win32') return
    expect(resolveKnowledgeToolPath('@/d/Ai/file.md', 'C:\\work'))
      .toBe('D:\\Ai\\file.md')
    expect(resolveKnowledgeToolPath('~/memory.md', 'C:\\work'))
      .toContain('memory.md')
  })
})
