/**
 * 进行中轮次的内部状态。
 *
 * 与持久化快照分开：这里只保存本轮基线与 Git 探测句柄，结算后即从内存
 * 移除，避免活动轮次状态被误当成可回放数据。
 */

import type { BaselineEntry } from './baseline'
import type { GitReaderLike, GitRepositorySnapshot } from './git'

export interface ActiveTurn {
  sessionId: string
  turnId: string
  rootPath: string
  startedAt: number
  /** 会话删除代际；结算时若已变化则丢弃结果。 */
  generation: number
  baselines: Map<string, BaselineEntry>
  order: string[]
  usedBytes: number
  droppedFiles: number
  gitReader: GitReaderLike | null
  gitSnapshot?: Promise<GitRepositorySnapshot | null>
}

export function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`
}
