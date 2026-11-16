/**
 * 额度展示缓存的读取与原子写入。
 *
 * 缓存只保存 Plan 名称、窗口、积分与时间戳，不包含 API Key、OAuth token
 * 或任何登录凭据；读取时会按渠道 `updatedAt` 丢弃换号前的旧数据。
 */

import type { PlanQuotaSnapshot, PlanQuotaSource } from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export interface PlanQuotaCacheFile {
  version?: number
  refreshedAt?: number
  channelVersions?: Record<string, number>
  sources?: PlanQuotaSource[]
}

export interface LoadedPlanQuotaCache {
  snapshot: PlanQuotaSnapshot
  channelVersions: Record<string, number>
}

interface CacheChannel {
  id: string
  updatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlanQuotaSource(value: unknown): value is PlanQuotaSource {
  if (!isRecord(value)) return false
  return typeof value.channelId === 'string'
    && typeof value.provider === 'string'
    && typeof value.label === 'string'
    && typeof value.updatedAt === 'number'
    && Array.isArray(value.windows)
}

/**
 * 读取缓存并按当前渠道校验版本。
 *
 * 返回 null 表示文件缺失、损坏或版本不兼容；调用方应从空快照开始。
 */
export function readPlanQuotaCache<T extends CacheChannel>(
  cachePath: string,
  channels: readonly T[],
  isEligible: (channel: T) => boolean,
  now: number,
  staleAfterMs: number,
): LoadedPlanQuotaCache | null {
  const cached = readJsonFileSafe<PlanQuotaCacheFile>(cachePath)
  if (!cached || cached.version !== 1 || !Array.isArray(cached.sources)) return null

  const versions: Record<string, number> = {}
  if (isRecord(cached.channelVersions)) {
    for (const [key, value] of Object.entries(cached.channelVersions)) {
      if (typeof value === 'number') versions[key] = value
    }
  }

  const sources = cached.sources
    .filter(isPlanQuotaSource)
    .filter((source) => {
      const channel = channels.find((item) => item.id === source.channelId)
      return !!channel
        && isEligible(channel)
        && versions[channel.id] === channel.updatedAt
    })

  const refreshedAt = typeof cached.refreshedAt === 'number' && Number.isFinite(cached.refreshedAt)
    ? cached.refreshedAt
    : 0
  return {
    channelVersions: versions,
    snapshot: {
      sources: sources.map((source) => ({ ...source })),
      refreshedAt,
      stale: sources.some((source) => source.stale === true)
        || (refreshedAt > 0 && now - refreshedAt > staleAfterMs),
    },
  }
}

/** 原子写入缓存；失败只记录日志，不影响额度展示。 */
export function writePlanQuotaCache(
  cachePath: string,
  snapshot: PlanQuotaSnapshot,
  channelVersions: Record<string, number>,
): void {
  try {
    writeJsonFileAtomic(cachePath, {
      version: 1,
      refreshedAt: snapshot.refreshedAt,
      channelVersions,
      sources: snapshot.sources,
    } satisfies PlanQuotaCacheFile)
  } catch (error) {
    console.warn('[额度汇总] 写入缓存失败:', error)
  }
}
