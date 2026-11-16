/**
 * Git Worktree 安全删除。
 *
 * 官方 0.22.0 的删除流程要求：
 * 1. 目标必须是该仓库已注册的 linked worktree，不能是主仓库；
 * 2. 调用方完成路径授权、运行中 Agent/终端占用检查与用户确认；
 * 3. 删除前后重新校验仓库归属，避免 Worktree 列表在确认期间漂移；
 * 4. 同一路径同时只允许一个删除操作。
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { normalizePathForCompare, type WorktreeInfo } from '@proma/shared'
import { getMainRepoRoot, invalidateGitDiffCache, listWorktrees } from './git-diff-service'

const execFileAsync = promisify(execFile)
const pendingRemovals = new Map<string, string>()

export interface RemoveGitWorktreeInput {
  repoPath: string
  worktreePath: string
  sessionId: string
  confirmed?: boolean
}

export interface WorktreeRemovalUsage {
  agentPaths: string[]
  terminalCwds: string[]
}

export interface WorktreeRemovalPolicy {
  authorize(repoRoot: string, worktreePath: string): Promise<boolean>
  assertNotInUse(worktreePath: string): void
  confirm(worktree: WorktreeInfo): Promise<boolean>
}

export interface RemoveGitWorktreeResult {
  removed: boolean
}

function canonicalPath(path: string): string {
  const absolutePath = resolve(path)
  try {
    return realpathSync(absolutePath)
  } catch {
    const parent = dirname(absolutePath)
    return parent === absolutePath
      ? absolutePath
      : join(canonicalPath(parent), basename(absolutePath))
  }
}

function isWithin(path: string, root: string): boolean {
  const remainder = relative(canonicalPath(root), canonicalPath(path))
  return remainder === ''
    || (remainder !== '..'
      && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder))
}

/** 任一目标与正在删除的 Worktree 互相包含时拒绝，避免并发删除竞态。 */
export function assertPathsNotBeingRemoved(paths: readonly string[]): void {
  for (const target of pendingRemovals.values()) {
    if (paths.some((path) => isWithin(path, target) || isWithin(target, path))) {
      throw new Error('相关 Worktree 正在等待或执行删除，请完成删除操作后重试')
    }
  }
}

export function assertWorktreeNotInUse(
  worktreePath: string,
  usage: WorktreeRemovalUsage,
): void {
  if (usage.agentPaths.some((path) => isWithin(path, worktreePath) || isWithin(worktreePath, path))) {
    throw new Error('该 Worktree 正被运行中的 Agent 使用，请先停止相关任务')
  }
  if (usage.terminalCwds.some((cwd) => isWithin(cwd, worktreePath))) {
    throw new Error('该 Worktree 中仍有内置终端，请先关闭相关终端')
  }
}

async function requireLinkedWorktree(input: RemoveGitWorktreeInput): Promise<WorktreeInfo> {
  let targetPath: string
  try {
    targetPath = await realpath(input.worktreePath)
  } catch {
    throw new Error('指定目录不是可用的 linked worktree')
  }
  const targetKey = normalizePathForCompare(targetPath)
  const worktrees = await listWorktrees(input.repoPath)
  for (const worktree of worktrees) {
    const registeredPath = await realpath(worktree.path).catch(() => null)
    if (!registeredPath || normalizePathForCompare(registeredPath) !== targetKey) continue
    if (worktree.isMain) throw new Error('不能删除主仓库')
    return { ...worktree, path: registeredPath }
  }
  throw new Error('指定目录不是该仓库的可用 linked worktree')
}

/**
 * 删除 linked worktree。
 * `confirmed !== true` 时只返回 removed=false，不执行任何校验或副作用。
 */
export async function removeGitWorktree(
  input: RemoveGitWorktreeInput,
  policy: WorktreeRemovalPolicy,
): Promise<RemoveGitWorktreeResult> {
  if (
    !input
    || typeof input.repoPath !== 'string'
    || !isAbsolute(input.repoPath)
    || typeof input.worktreePath !== 'string'
    || !isAbsolute(input.worktreePath)
    || typeof input.sessionId !== 'string'
    || !input.sessionId
  ) {
    throw new Error('删除 Worktree 参数无效')
  }
  if (input.confirmed !== true) return { removed: false }
  const worktree = await requireLinkedWorktree(input)
  const key = normalizePathForCompare(worktree.path)
  if (pendingRemovals.has(key)) {
    throw new Error('该 Worktree 正在等待删除，请勿重复操作')
  }
  pendingRemovals.set(key, worktree.path)
  try {
    const authorize = async (): Promise<string> => {
      const repoRoot = await getMainRepoRoot(worktree.path)
      if (!repoRoot || !(await policy.authorize(repoRoot, worktree.path))) {
        throw new Error('无权删除该 Worktree')
      }
      return repoRoot
    }
    const originalRepoRoot = normalizePathForCompare(await authorize())
    policy.assertNotInUse(worktree.path)
    if (!(await policy.confirm(worktree))) return { removed: false }
    await requireLinkedWorktree(input)
    const repoRoot = await authorize()
    if (normalizePathForCompare(repoRoot) !== originalRepoRoot) {
      throw new Error('Worktree 所属仓库已变化，请重新确认')
    }
    policy.assertNotInUse(worktree.path)
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', '--', worktree.path], {
        cwd: repoRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      throw new Error(
        `删除 Worktree 失败：${error instanceof Error ? error.message : 'Git 操作失败'}`,
      )
    }
    invalidateGitDiffCache(worktree.path)
    return { removed: true }
  } finally {
    pendingRemovals.delete(key)
  }
}
