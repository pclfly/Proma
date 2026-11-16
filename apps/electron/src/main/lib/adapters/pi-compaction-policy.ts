/**
 * CompactContext 阈值门控。
 *
 * Pi SDK 的自动压缩在上下文达到模型窗口约 80% 时触发（`shouldCompact`）。
 * 模型主动调用 CompactContext 时也遵守同一阈值，避免在窗口占用较低时提前压缩：
 * 未达阈值返回 skipped，工具不终止本回合，Agent 继续执行原任务。
 */

import { calculatePiAutoCompactionThresholdTokens } from '@proma/shared'

export const PI_COMPACTION_SCHEDULED_MESSAGE =
  '将在当前 Agent 回合安全结束后压缩当前会话上下文，并自动从已持久化的交接状态继续原始任务。'

export interface CurrentSessionCompactionUsage {
  tokens: number | null
  contextWindow: number
  thresholdTokens: number
}

export interface CurrentSessionCompactionDecision {
  scheduled: boolean
  message: string
  usage?: CurrentSessionCompactionUsage
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * 决定是否允许模型主动压缩当前会话。
 *
 * - tokens 为 null：最近一次压缩后还没有新的 usage，暂无可压缩内容，跳过。
 * - 无法判定窗口（无 usage / 非法窗口）：保持原行为放行，由 Pi 的 noop 兜底。
 * - tokens 未超过阈值（严格大于才触发，与 `shouldCompact` 一致）：跳过。
 */
export function decideCurrentSessionCompaction(
  usage: Pick<CurrentSessionCompactionUsage, 'tokens' | 'contextWindow'> | undefined,
): CurrentSessionCompactionDecision {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    return { scheduled: true, message: PI_COMPACTION_SCHEDULED_MESSAGE }
  }

  const thresholdTokens = calculatePiAutoCompactionThresholdTokens(usage.contextWindow)

  if (usage.tokens == null) {
    return {
      scheduled: false,
      message: '当前上下文刚完成压缩，暂无可压缩的历史内容。本次未压缩，请继续当前任务。',
      usage: { tokens: null, contextWindow: usage.contextWindow, thresholdTokens },
    }
  }

  if (usage.tokens <= thresholdTokens) {
    const percent = ((usage.tokens / usage.contextWindow) * 100).toFixed(1)
    return {
      scheduled: false,
      message: `当前上下文约 ${formatTokens(usage.tokens)} tokens，占模型窗口 ${formatTokens(usage.contextWindow)} 的 ${percent}%，未超过自动压缩阈值 ${formatTokens(thresholdTokens)}（80%）。本次未压缩，请继续当前任务，不要重复调用 CompactContext。`,
      usage: { tokens: usage.tokens, contextWindow: usage.contextWindow, thresholdTokens },
    }
  }

  return {
    scheduled: true,
    message: PI_COMPACTION_SCHEDULED_MESSAGE,
    usage: { tokens: usage.tokens, contextWindow: usage.contextWindow, thresholdTokens },
  }
}
