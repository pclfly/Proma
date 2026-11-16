/**
 * 会话检出（session checkout）解析。
 *
 * 官方 0.22.28 起，会话工作台目录转为隐式文件来源：文件引用直接指向会话当前检出，
 * 即默认项目目录或用户显式选中的 linked worktree。本模块只做纯逻辑：从历史检出中
 * 挑出仍然可用的目录，全部失效时回退到会话默认 cwd。
 *
 * 所有文件系统探测通过注入的 `isDirectory` 完成，不 import Electron，便于单测。
 */

import { posix } from 'node:path'

/** 会话检出历史中的一条记录。 */
export interface CheckoutHistoryEntry {
  /** 检出目录绝对路径 */
  path: string
  /** worktree 所属主仓库根目录 */
  repositoryRoot?: string
  /** 检出时的分支名 */
  branch?: string
  /** 检出时的基线 commit */
  baseCommit?: string
  /** 记录时间戳（毫秒） */
  recordedAt: number
}

/** 解析结果：当前会话应使用的检出目录。 */
export interface SessionCheckout {
  /** 可直接作为 Agent cwd 的目录 */
  path: string
  /** 是否回退到会话默认 cwd（没有任何可用的历史检出） */
  isFallback: boolean
  /** 是否存在过检出记录但全部失效，从而发生回退 */
  fellBack: boolean
}

/** 兼容 activeWorktree 结构的最小输入。 */
export interface SessionCheckoutCandidate {
  path: string
}

/** 会话 cwd 语义；缺失字段按旧版 session 工作台处理。 */
export type SessionCheckoutCwdMode = 'session' | 'project'

/** 解析会话检出的输入。 */
export interface ResolveSessionCheckoutInput {
  /** 历史检出，按时间追加，末尾为最近一次 */
  history?: readonly CheckoutHistoryEntry[]
  /** 兼容字段：旧会话显式激活的 linked worktree */
  activeWorktree?: SessionCheckoutCandidate
  /** 会话 cwd 语义 */
  agentCwdMode?: SessionCheckoutCwdMode
  /** agentCwdMode === 'project' 时的回退目录 */
  projectPath: string
  /** session 模式下的回退目录 */
  workbenchPath: string
}

/** 路径比较选项。 */
export interface CheckoutPathCompareOptions {
  /** 是否大小写不敏感；默认按平台判定 */
  caseInsensitive?: boolean
}

/** 历史检出最多保留的条数。 */
export const MAX_CHECKOUT_HISTORY = 20

/**
 * 按平台判定路径是否大小写不敏感。
 *
 * Windows 与 macOS 常见卷默认不敏感，Linux 等按敏感处理。导出以便测试固定平台行为。
 */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 归一化用于比较的检出路径。
 *
 * 只做词法归一：统一分隔符、去掉重复与末尾分隔符、折叠 `.` 与 `..`，并按平台处理
 * 大小写。不做 resolve / realpath，因此不会把不存在的路径解析到真实磁盘位置。
 */
export function normalizeCheckoutPathForCompare(
  path: string,
  caseInsensitive: boolean = isCaseInsensitivePlatform(),
): string {
  if (!path) return ''
  const unified = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, '') : unified
  const normalized = posix.normalize(trimmed)
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/**
 * 解析当前会话应使用的检出目录。
 *
 * 优先级：最近且仍存在的历史检出 → 仍存在的 activeWorktree → 会话默认 cwd。
 * 曾记录过检出但全部失效时返回 fellBack = true，供上层提示「已回退」。
 */
export function resolveSessionCheckout(
  input: ResolveSessionCheckoutInput,
  isDirectory: (path: string) => boolean,
): SessionCheckout {
  const history = input.history ?? []

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index]
    if (!candidate?.path) continue
    if (isDirectory(candidate.path)) {
      return { path: candidate.path, isFallback: false, fellBack: false }
    }
  }

  const activePath = input.activeWorktree?.path
  if (activePath && isDirectory(activePath)) {
    return { path: activePath, isFallback: false, fellBack: false }
  }

  const fallbackPath = input.agentCwdMode === 'project' ? input.projectPath : input.workbenchPath
  if (!fallbackPath) {
    throw new Error('缺少可回退的会话工作目录')
  }

  const hadCheckout = history.some((entry) => Boolean(entry?.path)) || Boolean(activePath)
  return { path: fallbackPath, isFallback: true, fellBack: hadCheckout }
}

/**
 * 追加一条检出记录。
 *
 * 按归一化路径去重（同路径旧记录被移除），新记录追加到末尾，最多保留 20 条。
 * 返回新数组，不修改入参。
 */
export function appendCheckoutEntry(
  history: readonly CheckoutHistoryEntry[],
  entry: CheckoutHistoryEntry,
  options: CheckoutPathCompareOptions = {},
): CheckoutHistoryEntry[] {
  if (!entry?.path) return [...history]

  const caseInsensitive = options.caseInsensitive ?? isCaseInsensitivePlatform()
  const key = normalizeCheckoutPathForCompare(entry.path, caseInsensitive)
  const remaining = history.filter(
    (item) => normalizeCheckoutPathForCompare(item.path, caseInsensitive) !== key,
  )
  remaining.push({ ...entry })
  return remaining.slice(-MAX_CHECKOUT_HISTORY)
}

/**
 * 判断给定路径是否就是历史中最新的检出目录。
 *
 * 只比较归一化后的路径，不访问文件系统；历史为空或路径为空时返回 false。
 */
export function isCurrentCheckout(
  history: readonly CheckoutHistoryEntry[],
  path: string,
  options: CheckoutPathCompareOptions = {},
): boolean {
  if (!path) return false
  const caseInsensitive = options.caseInsensitive ?? isCaseInsensitivePlatform()

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const latest = history[index]
    if (!latest?.path) continue
    return normalizeCheckoutPathForCompare(latest.path, caseInsensitive)
      === normalizeCheckoutPathForCompare(path, caseInsensitive)
  }

  return false
}
