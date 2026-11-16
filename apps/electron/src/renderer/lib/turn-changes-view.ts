/**
 * 连续改动视图的纯逻辑。
 *
 * 把主进程产出的每轮快照按时间连成一条流：相邻轮次间隔超过阈值时切成
 * 新的一段（可折叠），并统一生成时间、状态与 +/− 摘要文案。组件只负责
 * 渲染，不在这里读写状态或打开预览。
 */

import type { TurnChangeEntry, TurnChangeStatus, TurnChangesSnapshot } from '@proma/shared'

/** 相邻轮次间隔超过 10 分钟就折叠成「更早改动」区间。 */
export const TURN_GAP_THRESHOLD_MS = 10 * 60 * 1000
export const TURN_STREAM_DEFAULT_LIMIT = 100

export interface TurnStreamSummary {
  files: number
  additions: number
  deletions: number
  filesLabel: string
  diffLabel: string
  text: string
}

export type TurnStreamStatusTone = 'default' | 'stopped' | 'failed'

export interface TurnStreamTurnItem {
  kind: 'turn'
  key: string
  turn: TurnChangesSnapshot
  entries: TurnChangeEntry[]
  timeLabel: string
  statusLabel: string
  statusTone: TurnStreamStatusTone
  summary: TurnStreamSummary
}

export interface TurnStreamSection {
  key: string
  turns: TurnStreamTurnItem[]
  /** 折叠后的间隔文案对应的毫秒数；最新一段为它相对上一段的间隔。 */
  gapMs: number
  gapLabel?: string
  /** 除最新一段外，每个分隔都来自超过阈值的间隔，可折叠。 */
  collapsible: boolean
  collapsedByDefault: boolean
}

export interface TurnStreamOptions {
  gapThresholdMs?: number
  locale?: string
  timeZone?: string
}

export interface TurnChangeStatusMeta {
  label: string
  letter: string
  tone: TurnChangeStatus
}

const STATUS_META: Record<TurnChangeStatus, TurnChangeStatusMeta> = {
  created: { label: '新增', letter: 'A', tone: 'created' },
  modified: { label: '修改', letter: 'M', tone: 'modified' },
  deleted: { label: '删除', letter: 'D', tone: 'deleted' },
}

function statusMetaOf(outcome: TurnChangesSnapshot['status']): { label: string; tone: TurnStreamStatusTone } {
  switch (outcome) {
    case 'stopped':
      return { label: '已停止', tone: 'stopped' }
    case 'failed':
      return { label: '失败', tone: 'failed' }
    default:
      return { label: '已完成', tone: 'default' }
  }
}

/** 本轮所有条目的文件数与 +/− 行数汇总。 */
export function summarizeTurnChanges(turn: Pick<TurnChangesSnapshot, 'entries'>): TurnStreamSummary {
  const additions = turn.entries.reduce((sum, entry) => sum + entry.additions, 0)
  const deletions = turn.entries.reduce((sum, entry) => sum + entry.deletions, 0)
  const diffParts: string[] = []
  if (additions > 0) diffParts.push(`+${additions}`)
  if (deletions > 0) diffParts.push(`-${deletions}`)
  const diffLabel = diffParts.join(' ') || '无行数变化'
  const filesLabel = `${turn.entries.length} 个文件`
  return {
    files: turn.entries.length,
    additions,
    deletions,
    filesLabel,
    diffLabel,
    text: `${filesLabel} · ${diffLabel}`,
  }
}

export function getTurnChangeStatusMeta(status: TurnChangeStatus): TurnChangeStatusMeta {
  return STATUS_META[status]
}

/** 间隔文案：分钟、小时、天，避免出现「0 分钟」。 */
export function formatGapDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

/** 轮次开始时间（本地 HH:mm）。 */
export function formatTurnClock(timestamp: number, options: TurnStreamOptions = {}): string {
  try {
    return new Intl.DateTimeFormat(options.locale ?? 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(timestamp))
  } catch {
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

function toTurnItem(turn: TurnChangesSnapshot, options: TurnStreamOptions = {}): TurnStreamTurnItem {
  const status = statusMetaOf(turn.status)
  return {
    kind: 'turn',
    key: `turn:${turn.sessionId}:${turn.turnId}`,
    turn,
    entries: turn.entries,
    timeLabel: formatTurnClock(turn.startedAt, options),
    statusLabel: status.label,
    statusTone: status.tone,
    summary: summarizeTurnChanges(turn),
  }
}

/**
 * 按时间升序把轮次分组。
 * - 没有文件改动的轮次不进入流；
 * - 相邻轮次间隔超过阈值时开启新的一段，并带上间隔文案与可折叠标记。
 */
export function buildTurnStreamSections(
  turns: readonly TurnChangesSnapshot[],
  options: TurnStreamOptions = {},
): TurnStreamSection[] {
  const threshold = options.gapThresholdMs ?? TURN_GAP_THRESHOLD_MS
  const visible = [...turns]
    .filter((turn) => turn.entries.length > 0)
    .sort((left, right) => left.startedAt - right.startedAt || left.finishedAt - right.finishedAt)

  // 先按「相邻轮次间隔是否超过阈值」切段，段内保持时间升序。
  const drafts: Array<{ key: string; turns: TurnStreamTurnItem[]; gapBeforeMs: number }> = []
  let previous: TurnChangesSnapshot | null = null
  for (const turn of visible) {
    const gapMs = previous ? Math.max(0, turn.startedAt - previous.finishedAt) : 0
    const item = toTurnItem(turn, options)
    const latest = drafts[drafts.length - 1]
    if (!latest || gapMs > threshold) {
      drafts.push({ key: `section:${item.key}`, turns: [item], gapBeforeMs: gapMs })
    } else {
      latest.turns.push(item)
    }
    previous = turn
  }

  // 最新一段始终展开；更早的每一段都因超过阈值的间隔而可折叠，
  // 间隔文案取自它与下一段（更新的一段）之间的真实间隔。
  return drafts.map((draft, index) => {
    const isLatest = index === drafts.length - 1
    const nextGapMs = drafts[index + 1]?.gapBeforeMs ?? 0
    if (isLatest) {
      return {
        key: draft.key,
        turns: draft.turns,
        gapMs: draft.gapBeforeMs,
        collapsible: false,
        collapsedByDefault: false,
      }
    }
    return {
      key: draft.key,
      turns: draft.turns,
      gapMs: nextGapMs,
      gapLabel: `间隔 ${formatGapDuration(nextGapMs)}`,
      collapsible: true,
      collapsedByDefault: true,
    }
  })
}

/** 搜索过滤：匹配相对路径，命中轮次保留匹配条目；空查询原样返回。 */
export function filterTurnChanges(
  turns: readonly TurnChangesSnapshot[],
  query: string,
): TurnChangesSnapshot[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...turns]
  return turns
    .map((turn) => ({
      ...turn,
      entries: turn.entries.filter((entry) => entry.filePath.toLowerCase().includes(normalized)),
    }))
    .filter((turn) => turn.entries.length > 0)
}

/** 汇总整个流：轮次数、文件数（去重前）与增减行数。 */
export function countTurnChanges(turns: readonly TurnChangesSnapshot[]): {
  turns: number
  files: number
  additions: number
  deletions: number
} {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const turn of turns) {
    files += turn.entries.length
    additions += turn.entries.reduce((sum, entry) => sum + entry.additions, 0)
    deletions += turn.entries.reduce((sum, entry) => sum + entry.deletions, 0)
  }
  return { turns: turns.length, files, additions, deletions }
}

/** 拼接预览入口需要的绝对路径（渲染进程不依赖 node:path）。 */
export function joinRootAndPath(rootPath: string, filePath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalizedRoot) return normalizedFile
  return `${normalizedRoot}/${normalizedFile}`
}
