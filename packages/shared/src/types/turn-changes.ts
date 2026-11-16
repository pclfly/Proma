/**
 * 每轮文件改动记录（官方 0.22.28「连续改动视图」）。
 *
 * 主进程在 Agent 轮次内记录被写工具触达的文件，轮次结束时产出不可变的
 * TurnChangesSnapshot；渲染进程按轮次把改动连成一条时间流。
 * 这里只定义跨进程契约，不依赖 Electron / Node API。
 */

/** 单个文件在轮次内的变化类型。 */
export type TurnChangeStatus = 'created' | 'modified' | 'deleted'

/** 轮次结算状态：正常完成、用户停止、执行失败。 */
export type TurnChangeOutcome = 'completed' | 'stopped' | 'failed'

/** 轮次基线来源：直接读取工具执行前文件、Git HEAD、或缺失基线。 */
export type TurnChangeBaselineSource = 'file' | 'git-head' | 'missing'

export interface TurnChangeLine {
  line: number
  text: string
}

export interface TurnChangeHunk {
  context: string[]
  removed: TurnChangeLine[]
  added: TurnChangeLine[]
}

/** 轮次内单个文件的改动摘要。 */
export interface TurnChangeEntry {
  /** 相对 rootPath 的 POSIX 路径，用于展示与打开预览。 */
  filePath: string
  /** 该轮的工作目录根（项目根或会话 cwd）。 */
  rootPath: string
  status: TurnChangeStatus
  additions: number
  deletions: number
  /** 是否携带行级 hunk；二进制、超大文件或预算耗尽时为 false。 */
  diffAvailable: boolean
  /** hunk 是否因体积/数量被截断。 */
  truncated: boolean
  binary: boolean
  tooLarge: boolean
  symlink: boolean
  baselineSource: TurnChangeBaselineSource
  /** 变更前后字节数，二进制/超大文件也能给出摘要。 */
  sizeBefore?: number
  sizeAfter?: number
  /** 首个有意义的变更行，供空 diff 视图兜底展示。 */
  preview?: string
  hunks?: TurnChangeHunk[]
  updatedAt: number
}

/** 一轮 Agent 执行的不可变文件改动快照。 */
export interface TurnChangesSnapshot {
  version: 1
  sessionId: string
  turnId: string
  status: TurnChangeOutcome
  startedAt: number
  finishedAt: number
  rootPath: string
  entries: TurnChangeEntry[]
  filesChanged: number
  totalAdditions: number
  totalDeletions: number
  /** 超过单轮文件数量或字节预算而被忽略的目标数。 */
  droppedFiles?: number
}

export interface TurnChangesGetInput {
  sessionId: string
  /** 最多返回最近多少轮；省略时使用主进程上限。 */
  limit?: number
}

export interface TurnChangesGetResult {
  sessionId: string
  turns: TurnChangesSnapshot[]
}

/** 主进程 → 渲染进程：某轮改动已结算。 */
export interface TurnChangesChangedPayload {
  sessionId: string
  turn: TurnChangesSnapshot
}

/** 每轮文件改动 IPC 通道；与既有 diff 通道分开，避免影响现有调用方。 */
export const TURN_CHANGES_IPC_CHANNELS = {
  GET: 'turn-changes:get',
  CHANGED: 'turn-changes:changed',
} as const

/** 单文件快照上限（2 MiB）；超过只记录元数据。 */
export const TURN_CHANGES_MAX_FILE_BYTES = 2 * 1024 * 1024
/** 单轮最多记录的文件数。 */
export const TURN_CHANGES_MAX_FILES = 500
/** 单轮基线文本总量上限，避免一次大轮次撑爆主进程内存。 */
export const TURN_CHANGES_MAX_TOTAL_BYTES = 64 * 1024 * 1024
