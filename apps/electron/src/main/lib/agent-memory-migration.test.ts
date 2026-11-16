import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureMemoryFiles,
  memoryPaths,
  readGlobalProfile,
  readMemoryFile,
  type AgentMemoryContext,
} from './agent-memory'
import {
  migrateProfile,
  replanProfileMigration,
  resumeProfileMigration,
  type MemoryMigrationProposal,
} from './agent-memory-migration'

interface MigrationFixture {
  root: string
  ctx: AgentMemoryContext
  cleanup: () => void
}

function createFixture(): MigrationFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-agent-memory-migration-'))
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

const INDEX_WITH_PREFERENCES = '# 项目记忆索引\n\n## 主题\n\n- [prefs](project-preferences.md) — 偏好\n'

function legacySourcePath(ctx: AgentMemoryContext): string {
  return join(ctx.workspaceRoot, 'memory', 'user_profile.md')
}

function sourceIdFor(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex')
}

function buildProposal(ctx: AgentMemoryContext): MemoryMigrationProposal {
  const paths = memoryPaths(ctx)
  const sourcePath = legacySourcePath(ctx)
  const source = readMemoryFile(sourcePath)
  const global = readGlobalProfile(ctx)
  const preferences = readMemoryFile(paths.preferences)
  const index = readMemoryFile(paths.index)
  return {
    sourceId: sourceIdFor(sourcePath),
    sourceRevision: source.revision,
    globalRevision: global.revision,
    globalContent: '# 全局用户画像\n\n- 用户喜欢深色主题\n',
    preferencesRevision: preferences.revision,
    preferencesContent: null,
    sourceIndexRevision: index.revision,
    sourceIndexContent: INDEX_WITH_PREFERENCES,
    indexRevision: index.revision,
    indexContent: INDEX_WITH_PREFERENCES,
    rationale: '合并重复画像，保留来源与项目范围',
  }
}

describe('旧画像迁移', () => {
  test('Given 已登记旧画像 When 迁移 Then 合并全局画像、更新源索引并留档', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.index, INDEX_WITH_PREFERENCES, 'utf8')
      writeFileSync(legacySourcePath(fixture.ctx), '# 用户画像\n\n- 用户喜欢深色主题\n', 'utf8')

      const id = migrateProfile(fixture.ctx, buildProposal(fixture.ctx))
      expect(id).toMatch(/^[a-f0-9-]{36}$/)
      expect(existsSync(legacySourcePath(fixture.ctx))).toBe(false)
      expect(readGlobalProfile(fixture.ctx).content).toContain('深色主题')
      expect(readFileSync(paths.index, 'utf8')).toBe(INDEX_WITH_PREFERENCES)
      const directory = join(fixture.ctx.globalDir, 'migrations', id)
      expect(existsSync(join(directory, 'completed.json'))).toBe(true)
      expect(readFileSync(join(directory, 'source-profile.md'), 'utf8')).toContain('深色主题')
      expect(existsSync(join(directory, 'pending.json'))).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given .claude/memory 旧画像 When 迁移 Then 允许同步旧索引并保留项目索引', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const legacyDir = join(fixture.ctx.workspaceRoot, '.claude', 'memory')
      mkdirSync(legacyDir, { recursive: true })
      const sourcePath = join(legacyDir, 'user_profile.md')
      const sourceIndexPath = join(legacyDir, 'MEMORY.md')
      const sourceIndexContent = '# 旧索引\n\n- [other](other.md) — 保留\n'
      writeFileSync(sourceIndexPath, sourceIndexContent, 'utf8')
      writeFileSync(sourcePath, '# 用户画像\n\n- 旧事实\n', 'utf8')
      const projectIndexPath = memoryPaths(fixture.ctx).index
      writeFileSync(projectIndexPath, INDEX_WITH_PREFERENCES, 'utf8')

      const source = readMemoryFile(sourcePath)
      const global = readGlobalProfile(fixture.ctx)
      const preferences = readMemoryFile(memoryPaths(fixture.ctx).preferences)
      const sourceIndex = readMemoryFile(sourceIndexPath)
      const projectIndex = readMemoryFile(projectIndexPath)
      const id = migrateProfile(fixture.ctx, {
        sourceId: sourceIdFor(sourcePath),
        sourceRevision: source.revision,
        globalRevision: global.revision,
        globalContent: '# 全局用户画像\n\n- 旧事实\n',
        preferencesRevision: preferences.revision,
        preferencesContent: null,
        sourceIndexRevision: sourceIndex.revision,
        sourceIndexContent: '# 旧索引\n\n暂无。\n',
        indexRevision: projectIndex.revision,
        indexContent: INDEX_WITH_PREFERENCES,
        rationale: '同步 .claude/memory 旧索引',
      })
      expect(id).toMatch(/^[a-f0-9-]{36}$/)
      expect(existsSync(sourcePath)).toBe(false)
      expect(readFileSync(sourceIndexPath, 'utf8')).toBe('# 旧索引\n\n暂无。\n')
      expect(readFileSync(projectIndexPath, 'utf8')).toBe(INDEX_WITH_PREFERENCES)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 自动化会话 When 迁移 Then 拒绝且不修改文件', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.index, INDEX_WITH_PREFERENCES, 'utf8')
      const sourcePath = legacySourcePath(fixture.ctx)
      writeFileSync(sourcePath, '# 用户画像\n\n- 事实\n', 'utf8')
      const proposal = buildProposal(fixture.ctx)
      expect(() => migrateProfile({ ...fixture.ctx, allowProfileMigration: false }, proposal))
        .toThrow('不允许整合用户画像')
      expect(readFileSync(sourcePath, 'utf8')).toContain('事实')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 中断的 pending 记录 When resume Then 完成迁移并归档', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.index, INDEX_WITH_PREFERENCES, 'utf8')
      const sourcePath = legacySourcePath(fixture.ctx)
      writeFileSync(sourcePath, '# 用户画像\n\n- 用户偏好深色主题\n', 'utf8')
      const source = readMemoryFile(sourcePath)
      const global = readGlobalProfile(fixture.ctx)
      const index = readMemoryFile(paths.index)
      const id = randomUUID()
      const directory = join(fixture.ctx.globalDir, 'migrations', id)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'pending.json'), JSON.stringify({
        id,
        sourceId: sourceIdFor(sourcePath),
        workspaceRoot: fixture.ctx.workspaceRoot,
        sourcePath,
        sourceContent: source.content,
        rationale: '恢复中断迁移',
        createdAt: Date.now(),
        edits: [
          { target: 'global', before: global.content, after: '# 全局用户画像\n\n- 用户偏好深色主题\n' },
          { target: 'source-index', before: index.content, after: INDEX_WITH_PREFERENCES },
        ],
      }), 'utf8')

      expect(resumeProfileMigration(fixture.ctx, id)).toBe(id)
      expect(readGlobalProfile(fixture.ctx).content).toContain('深色主题')
      expect(existsSync(sourcePath)).toBe(false)
      expect(existsSync(join(directory, 'completed.json'))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 源文件丢失的 pending 记录 When replan Then 恢复源文件并退役计划', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const paths = memoryPaths(fixture.ctx)
      writeFileSync(paths.index, INDEX_WITH_PREFERENCES, 'utf8')
      const sourcePath = legacySourcePath(fixture.ctx)
      const sourceContent = '# 用户画像\n\n- 待恢复事实\n'
      const global = readGlobalProfile(fixture.ctx)
      const index = readMemoryFile(paths.index)
      const id = randomUUID()
      const directory = join(fixture.ctx.globalDir, 'migrations', id)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'pending.json'), JSON.stringify({
        id,
        sourceId: sourceIdFor(sourcePath),
        workspaceRoot: fixture.ctx.workspaceRoot,
        sourcePath,
        sourceContent,
        rationale: '需要重新规划',
        createdAt: Date.now(),
        edits: [
          { target: 'global', before: global.content, after: '# 全局用户画像\n' },
          { target: 'source-index', before: index.content, after: INDEX_WITH_PREFERENCES },
        ],
      }), 'utf8')

      expect(replanProfileMigration(fixture.ctx, id)).toBe(id)
      expect(readFileSync(sourcePath, 'utf8')).toBe(sourceContent)
      expect(existsSync(join(directory, 'pending.json'))).toBe(false)
      expect(existsSync(join(directory, 'superseded.json'))).toBe(true)
      expect(replanProfileMigration(fixture.ctx, id)).toBe(id)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 本地协作画像被伪造成迁移源 When resume Then 拒绝', () => {
    const fixture = createFixture()
    try {
      ensureMemoryFiles(fixture.ctx)
      const localPath = join(fixture.ctx.workspaceRoot, 'memory', 'user-profile.md')
      writeFileSync(localPath, '# 本地协作画像\n', 'utf8')
      const id = randomUUID()
      const directory = join(fixture.ctx.globalDir, 'migrations', id)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'pending.json'), JSON.stringify({
        id,
        sourceId: sourceIdFor(localPath),
        workspaceRoot: fixture.ctx.workspaceRoot,
        sourcePath: localPath,
        sourceContent: '# 本地协作画像\n',
        rationale: '伪造提案',
        createdAt: Date.now(),
        edits: [
          { target: 'global', before: null, after: '# 全局用户画像\n' },
          { target: 'source-index', before: null, after: INDEX_WITH_PREFERENCES },
        ],
      }), 'utf8')

      expect(() => resumeProfileMigration(fixture.ctx, id)).toThrow('本地协作画像')
      expect(readFileSync(localPath, 'utf8')).toBe('# 本地协作画像\n')
    } finally {
      fixture.cleanup()
    }
  })
})
