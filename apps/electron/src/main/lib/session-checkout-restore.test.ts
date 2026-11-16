import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPathWithinRoot,
  isRestorableWorktreeRecord,
  planWorktreeRestore,
  restoreWorktree,
  type WorktreeRestoreOptions,
  type WorktreeRestorePlanResult,
  type WorktreeRestoreProbe,
  type WorktreeRestoreRecord,
  type WorktreeRestoreRegistration,
  type WorktreeRestoreRejectionReason,
  type WorktreeRestoreResult,
} from './session-checkout-restore'

const WORKTREES_ROOT = join(tmpdir(), 'proma-session-checkout-worktrees')
const REPO_ROOT = join(tmpdir(), 'proma-session-checkout-repo')

function record(overrides: Partial<WorktreeRestoreRecord> = {}): WorktreeRestoreRecord {
  return {
    path: join(WORKTREES_ROOT, 'feature'),
    repositoryRoot: REPO_ROOT,
    branch: 'feature',
    baseCommit: 'abc1234',
    ...overrides,
  }
}

interface FakeGitState {
  calls: string[][]
  branchExists: boolean
  repositoryAvailable: boolean
  headCommit: string
  addError?: Error
  headError?: Error
}

function createFakeGit(overrides: Partial<FakeGitState> = {}): FakeGitState {
  return {
    calls: [],
    branchExists: true,
    repositoryAvailable: true,
    headCommit: 'abc1234',
    ...overrides,
  }
}

function createRunGit(state: FakeGitState): WorktreeRestoreOptions['runGit'] {
  return async (args) => {
    state.calls.push([...args])
    const [command, subcommand] = args
    if (command === 'rev-parse' && subcommand === '--git-dir') {
      if (!state.repositoryAvailable) throw new Error('not a git repository')
      return '.git\n'
    }
    if (command === 'branch' && subcommand === '--list') {
      return state.branchExists ? `${args[2] ?? ''}\n` : ''
    }
    if (command === 'worktree' && subcommand === 'add') {
      if (state.addError) throw state.addError
      return ''
    }
    if (command === 'rev-parse' && subcommand === 'HEAD') {
      if (state.headError) throw state.headError
      return `${state.headCommit}\n`
    }
    if (command === 'worktree' && subcommand === 'remove') return ''
    throw new Error(`未预期的 git 命令：${args.join(' ')}`)
  }
}

function createProbe(overrides: Partial<WorktreeRestoreProbe> = {}): WorktreeRestoreProbe {
  return {
    exists: () => false,
    isNonEmptyDirectory: () => false,
    isWithinRoot: () => true,
    isRepositoryAvailable: async () => true,
    branchExists: async () => true,
    ...overrides,
  }
}

function createOptions(
  git: FakeGitState,
  overrides: Partial<WorktreeRestoreOptions> = {},
): WorktreeRestoreOptions {
  return {
    runGit: createRunGit(git),
    exists: () => false,
    listWorktrees: async () => [],
    isNonEmptyDirectory: () => false,
    isWithinRoot: () => true,
    removeDirectory: () => undefined,
    ...overrides,
  }
}

function expectRejection(
  result: WorktreeRestorePlanResult | WorktreeRestoreResult,
  reason: WorktreeRestoreRejectionReason,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`预期拒绝，实际成功：${result.path}`)
  expect(result.reason).toBe(reason)
}

function hasWorktreeAddCall(git: FakeGitState): boolean {
  return git.calls.some((call) => call[0] === 'worktree' && call[1] === 'add')
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

function createTempRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  tempRoots.push(root)
  return root
}

describe('Worktree 恢复计划', () => {
  test('Given 记录完整 When 计划 Then 允许恢复且保留基线 commit', async () => {
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createProbe(),
    )

    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('预期计划成功')
    expect(plan.path).toBe(record().path)
    expect(plan.branch).toBe('feature')
    expect(plan.repositoryRoot).toBe(REPO_ROOT)
    expect(plan.baseCommit).toBe('abc1234')
    expect(plan.reusesEmptyDirectory).toBe(false)
  })

  test('Given 记录缺少分支 When 计划 Then 拒绝为记录不完整', async () => {
    const plan = await planWorktreeRestore(
      {
        record: { path: join(WORKTREES_ROOT, 'feature'), repositoryRoot: REPO_ROOT },
        worktreesRoot: WORKTREES_ROOT,
      },
      createProbe(),
    )

    expectRejection(plan, 'invalid-record')
  })

  test('Given 仓库不可用 When 计划 Then 拒绝且不触碰目标路径', async () => {
    let touched = false
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createProbe({
        isRepositoryAvailable: async () => false,
        exists: () => {
          touched = true
          return false
        },
      }),
    )

    expectRejection(plan, 'repository-unavailable')
    expect(touched).toBe(false)
  })

  test('Given 分支不存在 When 计划 Then 拒绝为分支缺失', async () => {
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createProbe({ branchExists: async () => false }),
    )

    expectRejection(plan, 'branch-missing')
  })

  test('Given 目标已存在且非空 When 计划 Then 拒绝为路径占用', async () => {
    const target = record().path
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createProbe({
        exists: (path) => path === target,
        isNonEmptyDirectory: (path) => path === target,
      }),
    )

    expectRejection(plan, 'target-exists')
  })

  test('Given 目标已存在但是空目录 When 计划 Then 允许复用该目录', async () => {
    const target = record().path
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createProbe({ exists: (path) => path === target }),
    )

    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('预期计划成功')
    expect(plan.reusesEmptyDirectory).toBe(true)
  })

  test('Given 记录路径逃逸 Worktree 根目录 When 计划 Then 拒绝为路径逃逸', async () => {
    const root = createTempRoot('proma-worktrees-root-')
    const escaped = join(root, '..', 'escaped-worktree')

    const plan = await planWorktreeRestore(
      { record: record({ path: escaped }), worktreesRoot: root },
      {
        exists: () => false,
        isRepositoryAvailable: async () => true,
        branchExists: async () => true,
      },
    )

    expectRejection(plan, 'path-outside-root')
  })

  test('Given 未配置 Worktree 根目录 When 计划 Then 拒绝为路径逃逸', async () => {
    const plan = await planWorktreeRestore(
      { record: record(), worktreesRoot: '' },
      createProbe(),
    )

    expectRejection(plan, 'path-outside-root')
  })
})

describe('Worktree 路径归属', () => {
  test('Given 目标位于根目录内或就是根目录 When 判断 Then 允许', () => {
    const root = createTempRoot('proma-root-check-')

    expect(isPathWithinRoot(root, join(root, 'feature'))).toBe(true)
    expect(isPathWithinRoot(root, root)).toBe(true)
  })

  test('Given 目标越界或仅是前缀相近 When 判断 Then 拒绝', () => {
    const root = createTempRoot('proma-root-check-')

    expect(isPathWithinRoot(root, join(root, '..', 'escaped'))).toBe(false)
    expect(isPathWithinRoot(root, `${root}-evil`)).toBe(false)
  })
})

describe('Worktree 恢复记录校验', () => {
  test('Given 完整且非主仓库的记录 When 校验 Then 通过', () => {
    expect(isRestorableWorktreeRecord(record())).toBe(true)
  })

  test('Given 缺少 branch 或 repositoryRoot When 校验 Then 拒绝', () => {
    expect(isRestorableWorktreeRecord({ path: join(WORKTREES_ROOT, 'feature') })).toBe(false)
    expect(isRestorableWorktreeRecord({
      path: join(WORKTREES_ROOT, 'feature'),
      repositoryRoot: REPO_ROOT,
    })).toBe(false)
  })

  test('Given 记录指向主仓库或 detached HEAD When 校验 Then 拒绝', () => {
    expect(isRestorableWorktreeRecord(record({
      path: REPO_ROOT,
      repositoryRoot: REPO_ROOT,
    }))).toBe(false)
    expect(isRestorableWorktreeRecord(record({ branch: '(detached)' }))).toBe(false)
  })

  test('Given 相对路径 When 校验 Then 拒绝', () => {
    expect(isRestorableWorktreeRecord(record({ path: 'worktrees/feature' }))).toBe(false)
  })
})

describe('Worktree 恢复执行', () => {
  test('Given 记录可恢复 When 恢复 Then 非强制创建 worktree 并返回 HEAD', async () => {
    const git = createFakeGit({ headCommit: 'deadbee' })

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`预期恢复成功：${result.message}`)
    expect(result.path).toBe(record().path)
    expect(result.branch).toBe('feature')
    expect(result.repositoryRoot).toBe(REPO_ROOT)
    expect(result.headCommit).toBe('deadbee')

    const addCall = git.calls.find((call) => call[0] === 'worktree' && call[1] === 'add')
    expect(addCall).toEqual(['worktree', 'add', '--', record().path, 'feature'])
    expect(git.calls.some((call) => call.includes('--force'))).toBe(false)
  })

  test('Given 目标已存在且非空 When 恢复 Then 拒绝且不执行 worktree add', async () => {
    const git = createFakeGit()
    const target = record().path

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git, {
        exists: (path) => path === target,
        isNonEmptyDirectory: () => true,
      }),
    )

    expectRejection(result, 'target-exists')
    expect(hasWorktreeAddCall(git)).toBe(false)
  })

  test('Given 分支已被其它 worktree 占用 When 恢复 Then 拒绝且不执行 worktree add', async () => {
    const git = createFakeGit()
    const registrations: WorktreeRestoreRegistration[] = [
      { path: join(WORKTREES_ROOT, 'other'), branch: 'feature', isMain: false },
    ]

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git, { listWorktrees: async () => registrations }),
    )

    expectRejection(result, 'branch-in-use')
    expect(hasWorktreeAddCall(git)).toBe(false)
  })

  test('Given 目标路径已被注册 When 恢复 Then 拒绝且不执行 worktree add', async () => {
    const git = createFakeGit()
    const target = record().path

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git, {
        listWorktrees: async () => [{ path: target, branch: 'another' }],
      }),
    )

    expectRejection(result, 'target-exists')
    expect(hasWorktreeAddCall(git)).toBe(false)
  })

  test('Given 分支不存在 When 恢复 Then 拒绝且不执行 worktree add', async () => {
    const git = createFakeGit({ branchExists: false })

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git),
    )

    expectRejection(result, 'branch-missing')
    expect(hasWorktreeAddCall(git)).toBe(false)
  })

  test('Given git worktree add 失败 When 恢复 Then 清理本次新建目录', async () => {
    const git = createFakeGit({ addError: new Error('add failed') })
    const target = record().path
    const directories = new Set<string>()
    const removed: string[] = []
    const options = createOptions(git, {
      exists: (path) => directories.has(path),
      removeDirectory: (path) => {
        removed.push(path)
        directories.delete(path)
      },
    })
    const runGit = options.runGit
    options.runGit = async (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') directories.add(target)
      return runGit(args, cwd)
    }

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      options,
    )

    expectRejection(result, 'git-failed')
    expect(removed).toEqual([target])
    expect(git.calls.some((call) => call[0] === 'worktree' && call[1] === 'remove')).toBe(true)
  })

  test('Given 目标原本是空目录且 add 失败 When 恢复 Then 不删除既有空目录', async () => {
    const git = createFakeGit({ addError: new Error('add failed') })
    const target = record().path
    const directories = new Set([target])
    const removed: string[] = []

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      createOptions(git, {
        exists: (path) => directories.has(path),
        removeDirectory: (path) => removed.push(path),
      }),
    )

    expectRejection(result, 'git-failed')
    expect(removed).toEqual([])
    expect(directories.has(target)).toBe(true)
  })

  test('Given 创建成功后读取 HEAD 失败 When 恢复 Then 清理本次新建目录', async () => {
    const git = createFakeGit({ headError: new Error('rev-parse failed') })
    const target = record().path
    const directories = new Set<string>()
    const removed: string[] = []
    const options = createOptions(git, {
      exists: (path) => directories.has(path),
      removeDirectory: (path) => {
        removed.push(path)
        directories.delete(path)
      },
    })
    const runGit = options.runGit
    options.runGit = async (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') directories.add(target)
      return runGit(args, cwd)
    }

    const result = await restoreWorktree(
      { record: record(), worktreesRoot: WORKTREES_ROOT },
      options,
    )

    expectRejection(result, 'git-failed')
    if (result.ok) throw new Error('预期拒绝')
    expect(result.message).toContain('HEAD')
    expect(removed).toEqual([target])
  })
})

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function listRealWorktrees(repositoryRoot: string): WorktreeRestoreRegistration[] {
  const output = git(['worktree', 'list', '--porcelain'], repositoryRoot)
  return output
    .split('\n\n')
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length) ?? ''
      const branch = lines.find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length)
      return { path, branch, isMain: index === 0 }
    })
    .filter((worktree) => Boolean(worktree.path))
}

describe('Worktree 恢复真实 Git 校验', () => {
  test('Given 真实仓库与历史记录 When 恢复 Then 磁盘重建 worktree 且 HEAD 与仓库一致', async () => {
    const root = createTempRoot('proma-restore-e2e-')
    const repo = join(root, 'repo')
    execFileSync('git', ['init', repo], { encoding: 'utf8' })
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    writeFileSync(join(repo, 'a.md'), '# a\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'init'], repo)
    git(['branch', 'feature'], repo)
    const repoHead = git(['rev-parse', 'HEAD'], repo).trim()

    const worktreesRoot = join(root, 'worktrees')
    const target = join(worktreesRoot, 'feature')

    const result = await restoreWorktree(
      {
        record: { path: target, repositoryRoot: repo, branch: 'feature' },
        worktreesRoot,
      },
      {
        runGit: async (args, cwd) => execFileSync('git', [...args], { cwd, encoding: 'utf8' }),
        exists: existsSync,
        listWorktrees: async (repositoryRoot) => listRealWorktrees(repositoryRoot),
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`预期恢复成功：${result.message}`)
    expect(result.headCommit).toBe(repoHead)
    expect(existsSync(join(target, 'a.md'))).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], target).trim()).toBe('feature')
  }, 90000)
})
