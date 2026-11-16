/**
 * Agent turn usage 汇总读取。
 *
 * 复用有界异步缓存：automation 的 daily 上下文判断、后续统计入口共用同一份
 * 短期结果，避免同一会话在并发调度/UI 查询时反复反向解析 JSONL。
 */

import { getSessionContextUsageRatio } from './agent-session-usage'
import { BoundedAsyncLookupCache } from './agent-turn-usage-cache'

export interface AgentTurnUsageReader {
  get: (sessionId: string) => Promise<number | undefined>
  clear: () => void
}

export function createAgentTurnUsageReader(
  lookup: (sessionId: string) => number | undefined = getSessionContextUsageRatio,
  options: { ttlMs?: number; maxEntries?: number; maxConcurrent?: number } = {},
): AgentTurnUsageReader {
  const cache = new BoundedAsyncLookupCache<number | undefined>({
    ttlMs: options.ttlMs ?? 30_000,
    maxEntries: options.maxEntries ?? 256,
    maxConcurrent: options.maxConcurrent ?? 4,
    // 读取失败/未知占用率不能缓存，否则会长期误判为可复用。
    shouldCache: (value) => value !== undefined,
  })
  return {
    get: (sessionId) => cache.getOrLoad(sessionId, async () => lookup(sessionId)),
    clear: () => cache.clear(),
  }
}

const reader = createAgentTurnUsageReader()

export function getAgentTurnUsage(sessionId: string): Promise<number | undefined> {
  return reader.get(sessionId)
}

export function clearAgentTurnUsageCache(): void {
  reader.clear()
}
