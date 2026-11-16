/**
 * 回合耗时与 token 用量的展示格式。
 *
 * 过程摘要与操作栏共用同一套口径，避免两处数字不一致。
 */

import type { AgentEventUsage } from '@proma/shared'

/** 格式化耗时（毫秒 → 可读字符串） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest.toFixed(0)}s`
}

/** 构建 usage tooltip 多行文本 */
export function buildUsageTooltip(durationMs: number, usage?: AgentEventUsage): string {
  const lines: string[] = []
  lines.push(`耗时: ${formatDuration(durationMs)}`)

  if (usage) {
    const pureInput = (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0)
    if (pureInput > 0) lines.push(`输入: ${pureInput.toLocaleString()}`)
    if (usage.outputTokens) lines.push(`输出: ${usage.outputTokens.toLocaleString()}`)
    if (usage.cacheCreationTokens) lines.push(`缓存写入: ${usage.cacheCreationTokens.toLocaleString()}`)
    if (usage.cacheReadTokens) lines.push(`缓存读取: ${usage.cacheReadTokens.toLocaleString()}`)
  }

  return lines.join('\n')
}
