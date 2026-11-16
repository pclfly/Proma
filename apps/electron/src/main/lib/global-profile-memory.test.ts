import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureMemoryFiles, type AgentMemoryContext } from './agent-memory'
import {
  readGlobalProfile,
  readGlobalProfileHistory,
  readGlobalProfileHistoryVersion,
  restoreGlobalProfileHistory,
  writeGlobalProfile,
} from './global-profile-memory'

const root = mkdtempSync(join(tmpdir(), 'proma-global-profile-'))
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

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('全局用户画像', () => {
  test('Given 初始化 When 读取 Then 返回默认画像与迁移状态', () => {
    ensureMemoryFiles(ctx)
    const profile = readGlobalProfile(ctx)
    expect(profile.content).toContain('全局')
    expect(profile.legacyCount).toBe(0)
    expect(profile.pendingCount).toBe(0)
    expect(profile.migrationIssues).toEqual([])
  })

  test('Given 当前 revision When 写入 Then 更新画像并产生历史', () => {
    const before = readGlobalProfile(ctx)
    const next = writeGlobalProfile(ctx, before.revision, `${before.content}\n\n- 偏好：先给结论。`)
    expect(next.content).toContain('先给结论')
    expect(next.revision).not.toBe(before.revision)

    const history = readGlobalProfileHistory(ctx, 8)
    expect(history.some((entry) => entry.current)).toBe(true)
    expect(history.some((entry) => entry.revision === before.revision)).toBe(true)
  })

  test('Given 历史版本 When 读取 Then 返回原正文', () => {
    const history = readGlobalProfileHistory(ctx, 8)
    const previous = history.find((entry) => !entry.current)
    expect(previous).toBeDefined()
    const version = readGlobalProfileHistoryVersion(ctx, previous!.revision)
    expect(version.revision).toBe(previous!.revision)
    expect(version.content).toContain('全局')
  })

  test('Given 历史版本 When 恢复 Then 当前画像回到该版本并保留历史', () => {
    const current = readGlobalProfile(ctx)
    const history = readGlobalProfileHistory(ctx, 8)
    const previous = history.find((entry) => !entry.current)
    const restored = restoreGlobalProfileHistory(ctx, previous!.revision, current.revision)
    expect(restored.revision).toBe(previous!.revision)
    expect(restored.content).toBe(readGlobalProfileHistoryVersion(ctx, previous!.revision).content)
    expect(readGlobalProfileHistory(ctx, 8).length).toBeGreaterThanOrEqual(history.length)
  })

  test('Given 非法 revision 或空内容 When 写入 Then 拒绝', () => {
    const current = readGlobalProfile(ctx)
    expect(() => writeGlobalProfile(ctx, 'not-a-revision', '内容')).toThrow('有效画像内容')
    expect(() => writeGlobalProfile(ctx, current.revision, '   ')).toThrow('有效画像内容')
  })
})
