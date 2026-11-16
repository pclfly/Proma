/**
 * 轮次记录器对外类型。
 *
 * 只放可注入依赖与调用参数，避免 recorder.ts 承载过多声明；主进程入口
 * 从 `./types` 重新导出这些类型。
 */

import type { TurnChangeOutcome, TurnChangesSnapshot } from '@proma/shared'
import type { CapturedFileSnapshot } from './capture'
import type { GitReaderLike } from './git'

export interface TurnChangeLimits {
  /** 单文件正文读取上限，默认 2 MiB。 */
  maxFileBytes?: number
  /** 单轮最多文件数，默认 500。 */
  maxFiles?: number
  /** 单轮基线文本总量上限，默认 64 MiB。 */
  maxTotalBytes?: number
}

export interface BeginTurnInput {
  sessionId: string
  turnId: string
  rootPath: string
  startedAt?: number
}

export type ToolTargetPhase = 'before' | 'after'

export interface NoteToolTargetsInput {
  sessionId: string
  turnId: string
  toolName: string
  input: Record<string, unknown>
  /** before = 工具执行前（捕获磁盘基线）；after = 工具执行后（可用 Git HEAD 兜底）。 */
  phase?: ToolTargetPhase
}

export interface FinishTurnInput {
  sessionId: string
  turnId: string
  status: TurnChangeOutcome
  finishedAt?: number
}

export type TurnChangeSettledListener = (snapshot: TurnChangesSnapshot) => void

export type TurnCaptureFile = (
  absolutePath: string,
  options: { maxFileBytes: number; remainingBytes: number },
) => CapturedFileSnapshot

export interface TurnChangeRecorderOptions {
  storageDir?: string
  limits?: TurnChangeLimits
  now?: () => number
  captureFile?: TurnCaptureFile
  createGitReader?: (rootPath: string) => GitReaderLike | null
  maxTurnsPerSession?: number
  maxSessions?: number
  retentionMs?: number
  pruneIntervalMs?: number
  /** 关闭周期清理定时器；测试可注入 false 避免悬挂句柄。 */
  pruneTimer?: boolean
}
