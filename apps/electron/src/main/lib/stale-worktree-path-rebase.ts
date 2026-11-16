/**
 * 历史 worktree 路径失效后的重定位。
 *
 * 官方 0.22.80：会话检出历史里记录的 worktree 路径可能已经不存在（目录被手动删除、
 * 仓库被移动或重命名）。此时按「仓库根 + 分支」在当前仍存在的 worktree 中找回；
 * 多个候选时判定为 ambiguous，绝不猜测。
 *
 * 路径归一只做大小写与分隔符的平台归一，不 resolve、不 realpath 不存在的路径。
 */

import {
  isCaseInsensitivePlatform,
  normalizeCheckoutPathForCompare,
  type CheckoutPathCompareOptions,
} from './session-checkout'

/** 历史 worktree 记录；可能来自旧版本，字段不完整。 */
export interface StaleWorktreeRecord {
  /** 历史 worktree 路径（可能已失效） */
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

/** 当前仍存在的 worktree 候选。 */
export interface StaleWorktreeCandidate {
  /** 候选 worktree 路径 */
  path: string
  /** 候选当前检出的分支名 */
  branch?: string
  /** 候选所属仓库根；调用方已按仓库过滤时可省略 */
  repositoryRoot?: string
  /** 主 worktree 不参与匹配 */
  isMain?: boolean
}

/** 重定位结果。 */
export interface StaleWorktreeRebaseResult {
  /** 修正后的记录；未重定位时原样返回 */
  record: StaleWorktreeRecord
  /** 是否把路径改写到当前仍存在的 worktree */
  rebased: boolean
  /** 存在多个同仓库同分支候选，无法安全判定 */
  ambiguous: boolean
  /** ambiguous 时的候选路径（保留原始写法），供上层让用户选择 */
  candidates: string[]
}

/**
 * 按「仓库根 + 分支」重定位失效的 worktree 记录。
 *
 * 分支名按 Git 语义大小写敏感；仓库根与路径按平台归一后比较。候选与记录指向同一
 * 路径时视为未变更。匹配到唯一候选才改写 path，多个候选返回 ambiguous 且不改写。
 */
export function rebaseStaleWorktreeRecord(
  record: StaleWorktreeRecord,
  candidates: readonly StaleWorktreeCandidate[],
  options: CheckoutPathCompareOptions = {},
): StaleWorktreeRebaseResult {
  const unchanged = (
    ambiguous = false,
    matched: readonly string[] = [],
  ): StaleWorktreeRebaseResult => ({
    record,
    rebased: false,
    ambiguous,
    candidates: [...matched],
  })

  if (!record || typeof record.path !== 'string' || !record.path) return unchanged()
  if (typeof record.repositoryRoot !== 'string' || !record.repositoryRoot) return unchanged()
  const branch = typeof record.branch === 'string' ? record.branch.trim() : ''
  if (!branch) return unchanged()

  const caseInsensitive = options.caseInsensitive ?? isCaseInsensitivePlatform()
  const currentKey = normalizeCheckoutPathForCompare(record.path, caseInsensitive)
  const repositoryKey = normalizeCheckoutPathForCompare(record.repositoryRoot, caseInsensitive)

  const targets = new Map<string, StaleWorktreeCandidate>()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.path !== 'string' || !candidate.path) continue
    if (candidate.isMain === true) continue
    if (candidate.branch !== branch) continue
    if (candidate.repositoryRoot) {
      const candidateRepoKey = normalizeCheckoutPathForCompare(
        candidate.repositoryRoot,
        caseInsensitive,
      )
      if (candidateRepoKey !== repositoryKey) continue
    }

    const key = normalizeCheckoutPathForCompare(candidate.path, caseInsensitive)
    if (key === currentKey || targets.has(key)) continue
    targets.set(key, candidate)
  }

  if (targets.size === 0) return unchanged()
  if (targets.size > 1) {
    return unchanged(true, Array.from(targets.values(), (candidate) => candidate.path))
  }

  const target = Array.from(targets.values())[0]
  if (!target) return unchanged()
  return {
    record: { ...record, path: target.path },
    rebased: true,
    ambiguous: false,
    candidates: [],
  }
}
