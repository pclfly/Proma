import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertWorktreeNotInUse,
  removeGitWorktree,
  type WorktreeRemovalPolicy,
} from './git-worktree-removal'

let root: string
let repo: string
let worktree: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function policy(overrides: Partial<WorktreeRemovalPolicy> = {}): WorktreeRemovalPolicy {
  return {
    authorize: async () => true,
    assertNotInUse: () => undefined,
    confirm: async () => true,
    ...overrides,
  }
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'proma-worktree-remove-')))
  repo = join(root, 'repo')
  worktree = join(root, 'wt')
  execFileSync('git', ['init', repo])
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  writeFileSync(join(repo, 'a.md'), '# a')
  git(['add', '.'], repo)
  git(['commit', '-m', 'init'], repo)
  git(['worktree', 'add', worktree, '-b', 'feature'], repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Worktree 删除', () => {
  test('Given 已确认 linked worktree When 删除 Then 真实移除并清理缓存', async () => {
    let authorized = 0
    let confirmed = 0
    const result = await removeGitWorktree({
      repoPath: repo,
      worktreePath: worktree,
      sessionId: 'session-1',
      confirmed: true,
    }, policy({
      authorize: async (_repoRoot, target) => {
        authorized += 1
        expect(target).toBe(realpathSync.native(worktree))
        return true
      },
      confirm: async (target) => {
        confirmed += 1
        expect(target.branch).toBe('feature')
        expect(target.isMain).toBe(false)
        return true
      },
    }))
    expect(result.removed).toBe(true)
    expect(authorized).toBe(2)
    expect(confirmed).toBe(1)
    expect(existsSync(worktree)).toBe(false)
  })

  test('Given 未确认 When 调用 Then 不校验、不删除', async () => {
    let called = false
    const result = await removeGitWorktree({
      repoPath: repo,
      worktreePath: worktree,
      sessionId: 'session-1',
      confirmed: false,
    }, policy({ authorize: async () => { called = true; return true } }))
    expect(result.removed).toBe(false)
    expect(called).toBe(false)
    expect(existsSync(worktree)).toBe(true)
  })

  test('Given 主仓库 When 删除 Then 拒绝', async () => {
    await expect(removeGitWorktree({
      repoPath: repo,
      worktreePath: repo,
      sessionId: 'session-1',
      confirmed: true,
    }, policy())).rejects.toThrow('不能删除主仓库')
  })

  test('Given 未授权或用户取消 When 删除 Then 保持 Worktree', async () => {
    await expect(removeGitWorktree({
      repoPath: repo,
      worktreePath: worktree,
      sessionId: 'session-1',
      confirmed: true,
    }, policy({ authorize: async () => false }))).rejects.toThrow('无权删除')
    const cancelled = await removeGitWorktree({
      repoPath: repo,
      worktreePath: worktree,
      sessionId: 'session-1',
      confirmed: true,
    }, policy({ confirm: async () => false }))
    expect(cancelled.removed).toBe(false)
    expect(existsSync(worktree)).toBe(true)
  })

  test('Given Agent 或终端占用 When 检查 Then 拒绝', () => {
    expect(() => assertWorktreeNotInUse(worktree, {
      agentPaths: [join(worktree, 'nested')],
      terminalCwds: [],
    })).toThrow('Agent')
    expect(() => assertWorktreeNotInUse(worktree, {
      agentPaths: [],
      terminalCwds: [worktree],
    })).toThrow('终端')
    expect(() => assertWorktreeNotInUse(worktree, {
      agentPaths: [join(root, 'other')],
      terminalCwds: [join(root, 'other')],
    })).not.toThrow()
  })
})
