/**
 * 会话检出与 worktree 恢复的主进程服务。
 *
 * 官方 0.22.28：会话工作台目录转为隐式文件来源，文件引用直接来自会话检出；
 * 用户可以从检出历史里找回并重建被移除的 worktree。恢复必须经过显式确认，
 * 且只在仓库/分支/目标路径全部复核通过后执行，绝不强制覆盖已有目录。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { AgentSessionMeta, SessionCheckoutHistoryEntry } from '@proma/shared'
import { normalizePathForCompare } from '@proma/shared'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { isAgentSessionActive } from './agent-service'
import { getAgentWorkspace, getWorktreeRepos } from './agent-workspace-manager'
import { listWorktrees } from './git-diff-service'
import { appendCheckoutEntry } from './session-checkout'
import {
  planWorktreeRestore,
  restoreWorktree,
  type WorktreeRestoreRecord,
} from './session-checkout-restore'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

export interface RestorableWorktree {
  path: string
  branch?: string
  repositoryRoot?: string
  recordedAt: number
}

export interface RestoreWorktreeResult {
  path: string
  branch?: string
}

/** 只依赖存在性判断，便于测试；历史里已存在的目录不算“待恢复”。 */
export function listRestorableFromHistory(
  history: readonly SessionCheckoutHistoryEntry[] | undefined,
  exists: (path: string) => boolean,
): RestorableWorktree[] {
  const seen = new Set<string>()
  const result: RestorableWorktree[] = []
  for (const entry of history ?? []) {
    if (!entry?.path || !entry.branch || !entry.repositoryRoot) continue
    if (exists(entry.path)) continue
    const key = normalizePathForCompare(entry.path)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      path: entry.path,
      branch: entry.branch,
      repositoryRoot: entry.repositoryRoot,
      recordedAt: entry.recordedAt,
    })
  }
  return result
}

export function listRestorableWorktrees(sessionId: string): RestorableWorktree[] {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return []
  return listRestorableFromHistory(session.checkoutHistory, existsSync)
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

async function findRepoConfig(session: AgentSessionMeta, repositoryRoot: string): Promise<{ worktreesPath: string } | undefined> {
  if (!session.workspaceId) return undefined
  const workspace = getAgentWorkspace(session.workspaceId)
  if (!workspace?.slug) return undefined
  const repos = await getWorktreeRepos(workspace.slug)
  return repos
    .filter((repo) => repo.worktreesPath && normalizePathForCompare(repo.repoPath) === normalizePathForCompare(repositoryRoot))
    .map((repo) => ({ worktreesPath: repo.worktreesPath! }))[0]
}

/**
 * 从检出历史恢复被移除的 worktree。
 * - confirmed 必须为 true；调用方负责先取得用户确认。
 * - 会话运行中拒绝，避免切换 cwd 打断正在执行的 Agent。
 */
export async function restoreSessionWorktree(
  input: { sessionId: string; path: string; confirmed?: boolean },
): Promise<RestoreWorktreeResult> {
  if (!input?.sessionId || !input.path) throw new Error('恢复 Worktree 参数无效')
  if (input.confirmed !== true) throw new Error('恢复 Worktree 需要用户确认')
  const session = getAgentSessionMeta(input.sessionId)
  if (!session) throw new Error('Agent 会话不存在')
  if (isAgentSessionActive(input.sessionId)) throw new Error('会话正在运行，请先停止 Agent 再恢复 Worktree')

  const key = normalizePathForCompare(input.path)
  const entry = (session.checkoutHistory ?? []).find((item) => normalizePathForCompare(item.path) === key)
  if (!entry) throw new Error('该路径不在会话检出历史中')
  if (!entry.branch || !entry.repositoryRoot) throw new Error('检出历史缺少仓库或分支信息，无法恢复')

  const repoConfig = await findRepoConfig(session, entry.repositoryRoot)
  if (!repoConfig) throw new Error('当前工作区未配置该仓库的 Worktree 目录')

  const record: WorktreeRestoreRecord = {
    path: entry.path,
    repositoryRoot: entry.repositoryRoot,
    branch: entry.branch,
    baseCommit: entry.baseCommit,
    recordedAt: entry.recordedAt,
  }
  const plan = await planWorktreeRestore(
    { record, worktreesRoot: repoConfig.worktreesPath },
    {
      exists: existsSync,
      isRepositoryAvailable: async (repo) => {
        try {
          await runGit(['rev-parse', '--git-dir'], repo)
          return true
        } catch {
          return false
        }
      },
      branchExists: async (repo, branch) => {
        try {
          return (await runGit(['branch', '--list', branch, '--format=%(refname:short)'], repo)).length > 0
        } catch {
          return false
        }
      },
    },
  )
  if (!plan.ok) throw new Error(plan.message)

  const restored = await restoreWorktree(
    { record, worktreesRoot: repoConfig.worktreesPath },
    {
      runGit,
      exists: existsSync,
      listWorktrees: async (repo) => listWorktrees(repo),
      removeDirectory: async (path) => { await rm(path, { recursive: true, force: true }) },
    },
  )
  if (!restored.ok) throw new Error(restored.message)

  const now = Date.now()
  updateAgentSessionMeta(input.sessionId, {
    activeWorktree: {
      path: restored.path,
      mainRepoRoot: entry.repositoryRoot,
      branch: restored.branch,
      selectedAt: now,
    },
    checkoutHistory: appendCheckoutEntry(session.checkoutHistory ?? [], {
      path: restored.path,
      repositoryRoot: entry.repositoryRoot,
      branch: restored.branch,
      baseCommit: restored.headCommit,
      recordedAt: now,
    }),
  })

  return { path: restored.path, branch: restored.branch }
}

/** 选择 worktree 时记录历史；同路径会移动到末尾，最多 20 条。 */
export function rememberSessionCheckout(
  session: AgentSessionMeta,
  entry: SessionCheckoutHistoryEntry,
): SessionCheckoutHistoryEntry[] {
  return appendCheckoutEntry(session.checkoutHistory ?? [], entry)
}

/** 供 IPC 复用的目录父级（恢复模块内部仍会做根目录复核）。 */
export function checkoutParentOf(path: string): string {
  return dirname(path)
}
