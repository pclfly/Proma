import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  PROFILE_MAX_CHARS,
  ProfileBudgetExceededError,
  archiveMemoryTheme,
  buildMemorySearchContext,
  ensureMemoryFiles,
  inspectLegacyProfileLocations,
  linkProjectMemory,
  listMemoryHistory,
  memoryPaths,
  memoryRevision,
  memoryTarget,
  pendingMemoryMigrations,
  readGlobalProfile,
  readMemoryFile,
  readMemoryReview,
  restoreMemoryVersion,
  updateMemory,
  updateMemoryEntries,
  withMemoryLock,
  type AgentMemoryContext,
} from './agent-memory'
import { searchMemory } from './memory-search'

interface MemoryFixture {
  root: string
  ctx: AgentMemoryContext
  cleanup: () => void
}

function createFixture(): MemoryFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-agent-memory-'))
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  const globalDir = join(root, 'global')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return {
    root,
    ctx: {
      globalDir,
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

describe('Agent Memory 存储', () => {
  test('Given 新工作区 When 初始化并写入 Then 建立必需文件并保留历史与审阅', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      expect(readFileSync(paths.profile, 'utf8')).toContain('全局用户画像')
      expect(readFileSync(paths.index, 'utf8')).toContain('项目记忆索引')

      const initialIndex = readMemoryFile(paths.index)
      const first = updateMemory(
        fixture.ctx,
        'MEMORY.md',
        initialIndex.revision,
        '# 项目记忆索引\n\n## 主题\n\n- [foo](foo.md) — 测试入口\n',
        '核验 foo 入口',
      )
      expect(first.content).toContain('foo.md')
      const review = readMemoryReview(fixture.ctx, first)
      expect(review.checkedAt).toBeGreaterThan(0)
      expect(review.reviewDue).toBe(false)

      const second = updateMemory(
        fixture.ctx,
        'MEMORY.md',
        first.revision,
        '# 项目记忆索引\n\n## 主题\n\n- [bar](bar.md) — 第二版\n',
        '更新 bar 入口',
      )
      const history = listMemoryHistory(fixture.ctx, 'MEMORY.md')
      expect(history.some((entry) => entry.revision === initialIndex.revision)).toBe(true)
      expect(history.some((entry) => entry.current)).toBe(true)

      const restored = restoreMemoryVersion(
        fixture.ctx,
        'MEMORY.md',
        initialIndex.revision,
        second.revision,
        '回滚测试',
      )
      expect(restored.content).toContain('项目记忆索引')
      expect(restored.content).not.toContain('bar.md')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 全局 Profile When 超过 5000 UTF-16 Then 拒绝且保留原文件', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const original = readGlobalProfile(fixture.ctx)
      expect(() => updateMemory(
        fixture.ctx,
        'global-profile',
        original.revision,
        'a'.repeat(PROFILE_MAX_CHARS + 1),
        '预算测试',
      )).toThrow(ProfileBudgetExceededError)
      expect(readGlobalProfile(fixture.ctx).content).toBe(original.content)

      const exact = updateMemory(
        fixture.ctx,
        'global-profile',
        original.revision,
        'a'.repeat(PROFILE_MAX_CHARS),
        '刚好达到预算',
      )
      expect(exact.content?.length).toBe(PROFILE_MAX_CHARS)

      expect(() => updateMemory(
        fixture.ctx,
        'global-profile',
        exact.revision,
        '😀'.repeat(2_501),
        'emoji 按 UTF-16 计数',
      )).toThrow(ProfileBudgetExceededError)
      expect(readGlobalProfile(fixture.ctx).content).toBe('a'.repeat(PROFILE_MAX_CHARS))
      expect(paths.profile).toContain('user_profile.md')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 旧 revision When 更新 Then 拒绝并提示重新合并', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const initial = readMemoryFile(paths.index)
      updateMemory(fixture.ctx, 'MEMORY.md', initial.revision, '# 第一版\n', '第一版')
      expect(() => updateMemory(fixture.ctx, 'MEMORY.md', initial.revision, '# 第二版\n', '第二版'))
        .toThrow('记忆已被其他会话修改')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 越界路径或符号链接 When 解析目标 Then 拒绝写入外部', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      expect(() => memoryTarget(fixture.ctx, '../escape.md')).toThrow('仅支持')
      expect(() => memoryTarget(fixture.ctx, '/abs.md')).toThrow('仅支持')
      expect(() => memoryTarget(fixture.ctx, 'user-profile.md')).toThrow('用户画像')

      const outside = join(fixture.root, 'outside.md')
      writeFileSync(outside, '外部内容', 'utf8')
      symlinkSync(outside, join(paths.directory, 'link.md'))
      expect(() => memoryTarget(fixture.ctx, 'link.md')).toThrow('越界')

      const profileFixture = createFixture()
      try {
        mkdirSync(profileFixture.ctx.globalDir, { recursive: true })
        const outsideProfile = join(profileFixture.root, 'outside-profile.md')
        writeFileSync(outsideProfile, '外部画像', 'utf8')
        symlinkSync(outsideProfile, memoryPaths(profileFixture.ctx).profile)
        expect(() => readGlobalProfile(profileFixture.ctx)).toThrow('越界')
      } finally {
        profileFixture.cleanup()
      }
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 已有条目 When 重复 add Then skipped duplicate 且不改写文件', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const initial = readMemoryFile(paths.index)
      const first = updateMemory(
        fixture.ctx,
        'MEMORY.md',
        initial.revision,
        '# 项目记忆索引\n\n## 主题\n\n- [foo](foo.md) — 入口\n',
        '建立索引',
      )
      const before = readMemoryFile(paths.index)
      const result = updateMemoryEntries(
        fixture.ctx,
        'MEMORY.md',
        first.revision,
        [{ op: 'add', entry: '[foo](foo.md) — 入口' }],
        '重复条目',
      )
      expect(result.changes).toEqual([])
      expect(result.skipped[0]?.reason).toBe('duplicate')
      expect(readMemoryFile(paths.index).content).toBe(before.content)
      expect(readMemoryFile(paths.index).revision).toBe(before.revision)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 记忆文件 When 空查询 Then 拒绝检索', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      expect(() => searchMemory(buildMemorySearchContext(fixture.ctx), '   ')).toThrow('关键词')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 未完成迁移 When 初始化或普通更新 Then 拒绝', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const id = randomUUID()
      const directory = join(fixture.ctx.globalDir, 'migrations', id)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'pending.json'), '{}', 'utf8')
      expect(pendingMemoryMigrations(fixture.ctx)).toEqual([id])
      expect(() => ensureMemoryFiles(fixture.ctx)).toThrow('未完成')
      const revision = readMemoryFile(paths.index).revision
      expect(() => updateMemory(fixture.ctx, 'MEMORY.md', revision, '# 更新\n', '更新')).toThrow('未完成')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 主题与索引 When 归档 Then 文件移入 archive 且索引移除入口', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      const initial = readMemoryFile(paths.index)
      const indexed = updateMemory(
        fixture.ctx,
        'MEMORY.md',
        initial.revision,
        '# 项目记忆索引\n\n## 主题\n\n- [topic](topic.md) — 测试\n',
        '建立主题入口',
      )
      const topic = updateMemory(
        fixture.ctx,
        'topic.md',
        memoryRevision(null),
        '# 测试主题\n\n- 一条事实\n',
        '创建主题',
      )
      const archive = archiveMemoryTheme(
        fixture.ctx,
        'topic.md',
        topic.revision,
        indexed.revision,
        '# 项目记忆索引\n\n## 主题\n\n暂无。\n',
      )
      expect(existsSync(memoryTarget(fixture.ctx, 'topic.md'))).toBe(false)
      expect(readFileSync(archive, 'utf8')).toContain('一条事实')
      expect(readFileSync(paths.index, 'utf8')).not.toContain('topic.md')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 项目 AGENTS.md When 关联记忆 Then 追加受管块且幂等', () => {
    const fixture = createFixture()
    try {
      const agentsPath = join(fixture.ctx.projectRoot, 'AGENTS.md')
      writeFileSync(agentsPath, '# 项目约定\n\n现有规则\n', 'utf8')
      ensureMemoryFiles(fixture.ctx)
      withMemoryLock(fixture.ctx, () => linkProjectMemory(fixture.ctx))
      const first = readFileSync(agentsPath, 'utf8')
      expect(first).toContain('<!-- proma:memory:start -->')
      expect(first).toContain(memoryPaths(fixture.ctx).profile)
      expect(first).toContain(memoryPaths(fixture.ctx).index)
      withMemoryLock(fixture.ctx, () => linkProjectMemory(fixture.ctx))
      expect(readFileSync(agentsPath, 'utf8')).toBe(first)

      rmSync(agentsPath)
      const outside = join(fixture.root, 'outside-agents.md')
      writeFileSync(outside, '# 外部\n', 'utf8')
      symlinkSync(outside, agentsPath)
      expect(() => withMemoryLock(fixture.ctx, () => linkProjectMemory(fixture.ctx)))
        .toThrow('不可安全修改')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 本地协作画像 When 发现旧画像 Then 排除连字符文件', () => {
    const fixture = createFixture()
    try {
      const memoryDir = join(fixture.ctx.workspaceRoot, 'memory')
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'user-profile.md'), '# 本地协作画像\n', 'utf8')
      expect(inspectLegacyProfileLocations(fixture.ctx).sources).toEqual([])

      writeFileSync(join(memoryDir, 'user_profile.md'), '# 官方旧画像\n', 'utf8')
      const sources = inspectLegacyProfileLocations(fixture.ctx).sources
      expect(sources.map((source) => source.path)).toContain(join(memoryDir, 'user_profile.md'))
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 超预算文件 When 读取 Then 拒绝而不是截断覆盖', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.index, 'x'.repeat(513 * 1024), 'utf8')
      expect(() => readMemoryFile(paths.index)).toThrow('512 KiB')
    } finally {
      fixture.cleanup()
    }
  })
})
