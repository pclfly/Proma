import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  ensureMemoryFiles,
  memoryPaths,
  readMemoryFile,
  updateMemory,
  type AgentMemoryContext,
} from '../agent-memory'
import { buildLiveMemoryContext, refreshMemorySystemMessages } from './pi-memory-context'

interface ContextFixture {
  root: string
  ctx: AgentMemoryContext
  cleanup: () => void
}

function createFixture(): ContextFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-memory-context-'))
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return {
    root,
    ctx: {
      globalDir: join(root, 'global'),
      workspaceRoot,
      projectRoot,
      canonicalProjectRoot: projectRoot,
      workspaces: [{ slug: 'demo', root: workspaceRoot }],
      allowProfileMigration: true,
      allowInstructionMaintenance: true,
      allowMemoryWrites: true,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('Live memory 上下文', () => {
  test('Given profile 与 MEMORY.md When 构建上下文 Then 注入 revision 与审阅状态', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const profile = readMemoryFile(paths.profile)
      updateMemory(
        fixture.ctx,
        'global-profile',
        profile.revision,
        '# 全局用户画像\n\n- 用户偏好中文回复\n',
        '确认偏好',
      )
      const index = readMemoryFile(paths.index)
      updateMemory(
        fixture.ctx,
        'MEMORY.md',
        index.revision,
        '# 项目记忆索引\n\n## 主题\n\n- [topic](topic.md) — 测试主题\n',
        '建立索引',
      )

      const context = buildLiveMemoryContext(fixture.ctx)
      expect(context).toContain('## 当前记忆')
      expect(context).toContain(`<memory_file path="${paths.profile}"`)
      expect(context).toContain(`<memory_file path="${paths.index}"`)
      expect(context).toContain('review_due="false"')
      expect(context).toContain('用户偏好中文回复')
      expect(context).toContain('topic.md')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 超预算 profile 与索引 When 构建上下文 Then 截断并给出预算提示', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.profile, 'p'.repeat(6_000), 'utf8')
      writeFileSync(paths.index, 'i'.repeat(4_000), 'utf8')
      const context = buildLiveMemoryContext(fixture.ctx)
      expect(context).toContain('p'.repeat(5_000))
      expect(context.includes('p'.repeat(5_001))).toBe(false)
      expect(context).toContain('Profile 超过 5000 字符')
      expect(context).toContain('超过纯路由索引预算')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 多条 system message When 刷新 Then proma_memory 只写入第一条并清理旧 section', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const messages: AgentMessage[] = [
        {
          role: 'system',
          content: '',
          sections: {
            project_context: '旧项目上下文',
            proma_memory: '旧记忆',
            proma_project_instructions: '保留的项目指令',
          },
          timestamp: 1,
        },
        { role: 'system', content: '第二条', sections: { proma_memory: '第二条旧记忆' }, timestamp: 2 },
        { role: 'user', content: 'hi', timestamp: 3 },
      ]
      const result = refreshMemorySystemMessages(messages, fixture.ctx, [
        { path: '/p/AGENTS.md', content: '项目规则' },
      ])
      const first = result[0]
      expect(first?.role).toBe('system')
      if (first?.role !== 'system') throw new Error('期望第一条为 system message')
      expect(first.sections?.proma_memory).toContain('当前记忆')
      expect(first.sections?.proma_memory).not.toContain('旧记忆')
      expect(first.sections?.proma_project_instructions).toBe('保留的项目指令')
      expect(first.sections?.project_context).toContain('<project_instructions path="/p/AGENTS.md">')
      expect(first.sections?.project_context).toContain('项目规则')

      const second = result[1]
      expect(second?.role).toBe('system')
      if (second?.role !== 'system') throw new Error('期望第二条为 system message')
      expect('proma_memory' in (second.sections ?? {})).toBe(false)
      expect('project_context' in (second.sections ?? {})).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 没有 system message When 刷新 Then 新建首条 system message', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const result = refreshMemorySystemMessages(
        [{ role: 'user', content: 'hi', timestamp: 1 }],
        fixture.ctx,
        [],
      )
      const first = result[0]
      expect(first?.role).toBe('system')
      if (first?.role !== 'system') throw new Error('期望新建 system message')
      expect(first.sections?.proma_memory).toContain('当前记忆')
      expect(first.sections?.project_context).toBeNull()
      expect(result[1]?.role).toBe('user')
    } finally {
      fixture.cleanup()
    }
  })
})
