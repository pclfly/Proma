/**
 * 从会话检出历史恢复被移除的 linked worktree。
 *
 * 官方 0.22.28 支持从会话检出历史找回并重建 worktree；官方 0.22.80 在其上补了
 * 历史路径失效时的重定位（见 stale-worktree-path-rebase）。
 *
 * 本模块只包含纯逻辑与注入式 Git 调用：路径授权、用户确认、运行中占用检查与 IPC
 * 由主进程接线负责。不 import Electron。
 */

import { readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeCheckoutPathForCompare } from './session-checkout'

/** 历史 worktree 记录；可能来自旧版本，字段不完整。 */
export interface WorktreeRestoreRecord {
  /** 历史 worktree 绝对路径 */
  path: string
  /** worktree 所属主仓库根目录 */
  repositoryRoot?: string
  /** 记录时的分支名 */
  branch?: string
  /** 记录时的基线 commit，仅作信息透传 */
  baseCommit?: string
  /** 记录时间戳（毫秒），仅作信息透传 */
  recordedAt?: number
}

/** 通过完整性校验后的记录。 */
export interface RestorableWorktreeRecord extends WorktreeRestoreRecord {
  path: string
  branch: string
  repositoryRoot: string
}

/** 恢复计划的拒绝原因。 */
export type WorktreeRestoreRejectionReason =
  | 'invalid-record'
  | 'path-outside-root'
  | 'repository-unavailable'
  | 'branch-missing'
  | 'branch-in-use'
  | 'target-exists'
  | 'git-failed'

/** 恢复计划：可以执行恢复。 */
export interface WorktreeRestorePlan {
  ok: true
  /** 目标 worktree 路径（保留记录中的原始写法） */
  path: string
  repositoryRoot: string
  branch: string
  baseCommit?: string
  /** 目标已存在但是空目录：git 可直接在其上创建 worktree */
  reusesEmptyDirectory: boolean
}

/** 恢复被拒绝。 */
export interface WorktreeRestoreRejection {
  ok: false
  reason: WorktreeRestoreRejectionReason
  /** 可直接展示给用户的中文说明 */
  message: string
}

export type WorktreeRestorePlanResult = WorktreeRestorePlan | WorktreeRestoreRejection

/** 计划阶段的输入。 */
export interface WorktreeRestorePlanInput {
  record: WorktreeRestoreRecord
  /** 配置的 worktree 根目录；目标必须位于其中，防止路径逃逸 */
  worktreesRoot: string
}

/** 计划阶段的只读探测能力。 */
export interface WorktreeRestoreProbe {
  /** 路径是否已存在（文件或目录） */
  exists(path: string): boolean
  /** 目录是否非空；缺省时读真实文件系统 */
  isNonEmptyDirectory?(path: string): boolean
  /** 目标是否位于根目录内；缺省时按 realpath 归一判断 */
  isWithinRoot?(root: string, target: string): boolean
  /** 仓库根是否仍可作为 Git 仓库使用 */
  isRepositoryAvailable(repositoryRoot: string): Promise<boolean>
  /** 分支是否存在于仓库 */
  branchExists(repositoryRoot: string, branch: string): Promise<boolean>
}

/** 已注册的 worktree（恢复流程所需的最少字段）。 */
export interface WorktreeRestoreRegistration {
  path: string
  branch?: string
  isMain?: boolean
}

/** 恢复请求。 */
export interface WorktreeRestoreRequest {
  record: WorktreeRestoreRecord
  worktreesRoot: string
}

/** 恢复流程注入的执行能力。 */
export interface WorktreeRestoreOptions {
  /** 执行 git 命令并返回 stdout；命令失败必须 reject */
  runGit(args: readonly string[], cwd: string): Promise<string>
  /** 路径是否已存在 */
  exists(path: string): boolean
  /** 列出仓库已注册的 worktree（应只返回磁盘上仍存在的项） */
  listWorktrees(repositoryRoot: string): Promise<readonly WorktreeRestoreRegistration[]>
  /** 目录是否非空；缺省时读真实文件系统 */
  isNonEmptyDirectory?(path: string): boolean
  /** 目标是否位于根目录内；缺省时按 realpath 归一判断 */
  isWithinRoot?(root: string, target: string): boolean
  /** 删除半成品目录；缺省时递归删除真实目录 */
  removeDirectory?(path: string): void
}

/** 恢复成功。 */
export interface WorktreeRestoreSuccess {
  ok: true
  /** 新建 worktree 的实际路径 */
  path: string
  repositoryRoot: string
  branch: string
  /** 新建 worktree 的 HEAD commit */
  headCommit: string
}

export type WorktreeRestoreResult = WorktreeRestoreSuccess | WorktreeRestoreRejection

function reject(
  reason: WorktreeRestoreRejectionReason,
  message: string,
): WorktreeRestoreRejection {
  return { ok: false, reason, message }
}

/**
 * 判断记录是否足以用于恢复。
 *
 * 要求 path 与 repositoryRoot 都是绝对路径、branch 非空且不是 detached，
 * 并且 path 不是主仓库根目录本身。
 */
export function isRestorableWorktreeRecord(
  record: WorktreeRestoreRecord | null | undefined,
): record is RestorableWorktreeRecord {
  if (!record || typeof record.path !== 'string' || typeof record.repositoryRoot !== 'string') {
    return false
  }
  if (!isAbsolute(record.path) || !isAbsolute(record.repositoryRoot)) return false
  if (typeof record.branch !== 'string') return false
  const branch = record.branch.trim()
  if (!branch || branch === '(detached)') return false

  return normalizeCheckoutPathForCompare(record.path)
    !== normalizeCheckoutPathForCompare(record.repositoryRoot)
}

/**
 * 解析路径的真实位置。
 *
 * 不存在的路径回溯到最近的存在祖先，保证「目标尚未创建」时仍能判断它归属于哪个根目录。
 */
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

/** 判断目标是否位于根目录内（含根目录自身）。 */
export function isPathWithinRoot(root: string, target: string): boolean {
  if (!root || !target) return false
  const remainder = relative(canonicalPath(root), canonicalPath(target))
  return remainder === ''
    || (remainder !== '..'
      && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder))
}

function defaultIsNonEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length > 0
  } catch {
    return false
  }
}

function defaultRemoveDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/**
 * 计算恢复计划，不产生任何副作用。
 *
 * 拒绝顺序：记录不完整 → 路径逃逸 → 仓库不可用 → 分支不存在 → 目标已存在且非空。
 * 目标已存在但为空目录时允许恢复，与 `git worktree add` 的行为保持一致。
 */
export async function planWorktreeRestore(
  input: WorktreeRestorePlanInput,
  probe: WorktreeRestoreProbe,
): Promise<WorktreeRestorePlanResult> {
  const record = input.record
  if (!isRestorableWorktreeRecord(record)) {
    return reject('invalid-record', '历史记录缺少路径、分支或仓库根，无法恢复 Worktree')
  }

  const isWithinRoot = probe.isWithinRoot ?? isPathWithinRoot
  if (!input.worktreesRoot || !isWithinRoot(input.worktreesRoot, record.path)) {
    return reject('path-outside-root', '目标路径不在允许的 Worktree 根目录内')
  }

  if (!(await probe.isRepositoryAvailable(record.repositoryRoot))) {
    return reject('repository-unavailable', '仓库不可用，无法恢复 Worktree')
  }

  if (!(await probe.branchExists(record.repositoryRoot, record.branch))) {
    return reject('branch-missing', `分支 ${record.branch} 不存在，无法恢复 Worktree`)
  }

  const isNonEmptyDirectory = probe.isNonEmptyDirectory ?? defaultIsNonEmptyDirectory
  const targetExists = probe.exists(record.path)
  if (targetExists && isNonEmptyDirectory(record.path)) {
    return reject('target-exists', '目标路径已存在且非空，无法恢复 Worktree')
  }

  return {
    ok: true,
    path: record.path,
    repositoryRoot: record.repositoryRoot,
    branch: record.branch,
    baseCommit: record.baseCommit,
    reusesEmptyDirectory: targetExists,
  }
}

/**
 * 用注入的 runGit 实现计划阶段需要的仓库 / 分支探测。
 *
 * `git rev-parse --git-dir` 失败即视为仓库不可用；`git branch --list` 找不到分支时
 * 退出码仍为 0，因此以输出内容精确比对分支名（分支名大小写敏感）。
 */
function createGitProbe(options: WorktreeRestoreOptions): WorktreeRestoreProbe {
  return {
    exists: options.exists,
    isNonEmptyDirectory: options.isNonEmptyDirectory,
    isWithinRoot: options.isWithinRoot,
    async isRepositoryAvailable(repositoryRoot) {
      try {
        await options.runGit(['rev-parse', '--git-dir'], repositoryRoot)
        return true
      } catch {
        return false
      }
    },
    async branchExists(repositoryRoot, branch) {
      try {
        const output = await options.runGit(
          ['branch', '--list', branch, '--format=%(refname:short)'],
          repositoryRoot,
        )
        return output.split(/\r?\n/).some((line) => line.trim() === branch)
      } catch {
        return false
      }
    },
  }
}

/**
 * 清理本次恢复产生的半成品。
 *
 * 先尝试不带 --force 的 `git worktree remove`（刚创建、无占用时 Git 会一并注销），
 * 失败再删除目录。仅处理本次新建的目标，调用方必须先行确认。
 * 若 Git 未能注销注册（例如目录已被并发写入），注册信息可能残留，需上层择机
 * 执行 `git worktree prune`。
 */
async function cleanupHalfCreatedWorktree(
  plan: WorktreeRestorePlan,
  options: WorktreeRestoreOptions,
): Promise<void> {
  try {
    await options.runGit(['worktree', 'remove', '--', plan.path], plan.repositoryRoot)
  } catch {
    // 未注册或仍被占用：退回删除目录
  }

  try {
    if (options.exists(plan.path)) {
      const removeDirectory = options.removeDirectory ?? defaultRemoveDirectory
      removeDirectory(plan.path)
    }
  } catch {
    // 清理失败不改变对调用方的失败结论
  }
}

function readGitError(error: unknown): string {
  return error instanceof Error ? error.message : 'Git 操作失败'
}

/**
 * 从历史记录恢复 linked worktree。
 *
 * 先复核仓库与分支（计划阶段），再确认目标未被已注册 worktree 占用、分支未被其它
 * worktree 占用；随后执行不带强制的 `git worktree add`，最后读取新 worktree 的 HEAD。
 * 失败时只有本次新建的目录会被清理，预先存在的空目录保持原样。
 */
export async function restoreWorktree(
  request: WorktreeRestoreRequest,
  options: WorktreeRestoreOptions,
): Promise<WorktreeRestoreResult> {
  const plan = await planWorktreeRestore(request, createGitProbe(options))
  if (!plan.ok) return plan

  let registrations: readonly WorktreeRestoreRegistration[]
  try {
    registrations = await options.listWorktrees(plan.repositoryRoot)
  } catch {
    return reject('repository-unavailable', '仓库不可用，无法恢复 Worktree')
  }

  const targetKey = normalizeCheckoutPathForCompare(plan.path)
  if (registrations.some(
    (worktree) => normalizeCheckoutPathForCompare(worktree.path) === targetKey,
  )) {
    return reject('target-exists', '目标路径已被现有 Worktree 占用')
  }
  if (registrations.some((worktree) => worktree.branch === plan.branch)) {
    return reject('branch-in-use', `分支 ${plan.branch} 已被其它 Worktree 占用`)
  }

  const isNonEmptyDirectory = options.isNonEmptyDirectory ?? defaultIsNonEmptyDirectory
  const targetExistedBefore = options.exists(plan.path)
  if (targetExistedBefore && isNonEmptyDirectory(plan.path)) {
    return reject('target-exists', '目标路径已存在且非空，无法恢复 Worktree')
  }

  try {
    await options.runGit(
      ['worktree', 'add', '--', plan.path, plan.branch],
      plan.repositoryRoot,
    )
  } catch (error) {
    if (!targetExistedBefore) await cleanupHalfCreatedWorktree(plan, options)
    return reject('git-failed', `恢复 Worktree 失败：${readGitError(error)}`)
  }

  let headCommit: string
  try {
    headCommit = (await options.runGit(['rev-parse', 'HEAD'], plan.path)).trim()
    if (!headCommit) throw new Error('Git 未返回 HEAD commit')
  } catch (error) {
    if (!targetExistedBefore) await cleanupHalfCreatedWorktree(plan, options)
    return reject('git-failed', `恢复 Worktree 后读取 HEAD 失败：${readGitError(error)}`)
  }

  return {
    ok: true,
    path: plan.path,
    repositoryRoot: plan.repositoryRoot,
    branch: plan.branch,
    headCommit,
  }
}
