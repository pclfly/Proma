/**
 * Cloud API Key 服务（纯逻辑部分）
 *
 * 从官方 0.22.0 `src/main/lib/cloud-api-keys-service.ts` 与
 * `src/main/lib/proma-agent-key-service.ts` 提取：
 * - App Key 输入校验与命名
 * - inner key 复用 / 创建 / 超限判定
 * - App Key 数量上限判定
 *
 * 真实 key 列表、创建、删除与缓存轮换 deferred。
 */

import type { CloudApiKey } from '@proma/cloud'
import type { CloudServiceResult } from './cloud-service-types'

/** 官方 inner key 名称 */
export const PROMA_AGENT_INNER_KEY_NAME = 'proma-agent-inner'
/** 官方 inner key 描述 */
export const PROMA_AGENT_INNER_KEY_DESCRIPTION = 'Proma Agent 专用，可删除（自动重建）'
/** inner key 内存缓存时长（1 小时） */
export const PROMA_AGENT_INNER_KEY_CACHE_TTL_MS = 60 * 60 * 1_000
/** 同名 ACTIVE inner key 告警/上限阈值 */
export const MAX_PROMA_AGENT_INNER_KEYS = 5
/** App Key 名前缀 */
export const PROMA_APP_KEY_PREFIX = 'app-'
/** 单个用户最多 App Key 数 */
export const MAX_PROMA_APP_KEYS = 20
/** App 名仅允许 kebab-case */
export const PROMA_APP_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** App Key 默认配额 */
export const DEFAULT_PROMA_APP_QUOTA = 50

export interface CreatePromaAppKeyInput {
  appName: string
  description: string
  quotaLimit?: number
}

export type PromaAppKeyValidationResult =
  | { ok: true; appName: string; description: string; quotaLimit: number }
  | { ok: false; error: string }

/**
 * 校验创建 App Key 的输入。
 *
 * 错误文案与官方保持一致（英文），校验顺序也与官方一致：
 * appName → quotaLimit → description。
 */
export function validatePromaAppKeyInput(input: CreatePromaAppKeyInput): PromaAppKeyValidationResult {
  const quotaLimit = input.quotaLimit ?? DEFAULT_PROMA_APP_QUOTA
  if (!PROMA_APP_NAME_PATTERN.test(input.appName)) {
    return {
      ok: false,
      error: `Invalid appName "${input.appName}": must be kebab-case (lowercase letters, digits, hyphens only).`,
    }
  }
  if (quotaLimit <= 0) {
    return { ok: false, error: `Invalid quotaLimit ${quotaLimit}: must be > 0.` }
  }
  if (input.description.length > 200) {
    return {
      ok: false,
      error: `description too long (${input.description.length} > 200 chars).`,
    }
  }
  return { ok: true, appName: input.appName, description: input.description, quotaLimit }
}

/** 本地日期 YYYYMMDD（官方 formatTodayYYYYMMDD 等价实现） */
export function formatTodayYYYYMMDD(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 生成 App Key 名称：app-<appName>-<YYYYMMDD> */
export function buildPromaAppKeyName(appName: string, date: Date = new Date()): string {
  return `${PROMA_APP_KEY_PREFIX}${appName}-${formatTodayYYYYMMDD(date)}`
}

export type PromaInnerKeyDecision =
  | { action: 'reuse'; key: string; duplicates: number }
  | { action: 'create' }
  | { action: 'error'; error: string }

/**
 * 决定 inner key 是复用、创建还是拒绝。
 *
 * 与官方一致：
 * - 存在同名 ACTIVE key → 复用第一个；达到阈值时由调用方告警；
 * - 不存在 ACTIVE 但同名 key 已达上限 → 拒绝创建；
 * - 否则创建。
 */
export function decidePromaInnerKey(
  keys: Array<Pick<CloudApiKey, 'name' | 'status' | 'key'>>,
): PromaInnerKeyDecision {
  const candidates = keys.filter((key) => (
    key.name === PROMA_AGENT_INNER_KEY_NAME
    && key.status === 'ACTIVE'
    && typeof key.key === 'string'
    && key.key.length > 0
  ))
  if (candidates.length > 0) {
    const chosen = candidates[0]
    if (chosen && typeof chosen.key === 'string') {
      return { action: 'reuse', key: chosen.key, duplicates: candidates.length }
    }
  }

  const allSameName = keys.filter((key) => key.name === PROMA_AGENT_INNER_KEY_NAME)
  if (allSameName.length >= MAX_PROMA_AGENT_INNER_KEYS) {
    return {
      action: 'error',
      error: `Too many "${PROMA_AGENT_INNER_KEY_NAME}" keys (${allSameName.length} >= ${MAX_PROMA_AGENT_INNER_KEYS}). Please clean up old/disabled keys in your settings panel.`,
    }
  }
  return { action: 'create' }
}

/**
 * 判断是否还能创建 App Key。
 *
 * 返回错误文案或 undefined（可创建）。
 */
export function getPromaAppKeyLimitError(keys: Array<Pick<CloudApiKey, 'name'>>): string | undefined {
  const appKeyCount = keys.filter((key) => key.name.startsWith(PROMA_APP_KEY_PREFIX)).length
  if (appKeyCount >= MAX_PROMA_APP_KEYS) {
    return `Too many app keys (${appKeyCount} >= ${MAX_PROMA_APP_KEYS}). Please clean up unused app keys in your Proma settings panel before creating new ones.`
  }
  return undefined
}

/** API Key 服务类型契约；实现留给后续批次。 */
export interface CloudApiKeysService {
  listApiKeys(): Promise<CloudServiceResult<CloudApiKey[]>>
  createApiKey(params: { name: string; description?: string; quotaLimit?: number }): Promise<CloudServiceResult<CloudApiKey>>
  deleteApiKey(keyId: string): Promise<CloudServiceResult<void>>
}
