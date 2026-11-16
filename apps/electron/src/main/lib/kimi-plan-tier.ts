/**
 * Kimi 会员档位与额度区域解析。
 *
 * 这里只做纯解析与 URL 选择，不发起任何网络请求：
 * - 国内 `api.kimi.com` 与海外 `api.kimi.ai` 使用不同的 coding 额度端点；
 * - 会员档位来自额度响应中的 `user_level_name` / `userLevelName`，
 *   响应可能被 `data` / `user` / `profile` 等包装。
 */

export type KimiPlanRegion = 'cn' | 'global'

const KIMI_CN_QUOTA_URL = 'https://api.kimi.com/coding/v1/usages'
const KIMI_GLOBAL_QUOTA_URL = 'https://api.kimi.ai/coding/v1/usages'

/** 响应中可能承载会员档位的字段名，兼容 snake_case 与 camelCase。 */
const KIMI_TIER_KEYS = ['user_level_name', 'userLevelName'] as const

/** 常见响应包装层；只沿这些键向下查找，避免误读无关嵌套对象。 */
const KIMI_WRAPPER_KEYS = ['data', 'user', 'profile', 'account', 'subscription', 'membership'] as const

const KIMI_MAX_WRAPPER_DEPTH = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 根据渠道 Base URL 判断 Kimi 额度区域。
 *
 * 缺省或无法解析时按国内处理，与现有渠道默认地址保持一致。
 */
export function resolveKimiPlanRegion(baseUrl: string | undefined): KimiPlanRegion {
  if (!baseUrl) return 'cn'
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'api.kimi.ai' || hostname.endsWith('.kimi.ai') ? 'global' : 'cn'
  } catch {
    return /(^|[./])api\.kimi\.ai([/]|$)/i.test(baseUrl) ? 'global' : 'cn'
  }
}

/** 返回对应区域的 Kimi Coding 额度查询地址。 */
export function resolveKimiPlanQuotaUrl(baseUrl: string | undefined): string {
  return resolveKimiPlanRegion(baseUrl) === 'global' ? KIMI_GLOBAL_QUOTA_URL : KIMI_CN_QUOTA_URL
}

/**
 * 从额度响应中提取会员档位名。
 *
 * 支持 `data` / `user` / `profile` 等包装（含数组形式的包装），
 * 找不到合法字符串时返回 undefined，调用方不得伪造档位。
 */
export function extractKimiUserLevelName(payload: unknown): string | undefined {
  let current: unknown[] = [payload]

  for (let depth = 0; depth < KIMI_MAX_WRAPPER_DEPTH; depth += 1) {
    const next: unknown[] = []
    for (const node of current) {
      if (!isRecord(node)) continue

      for (const key of KIMI_TIER_KEYS) {
        const value = node[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }

      for (const key of KIMI_WRAPPER_KEYS) {
        const value = node[key]
        if (isRecord(value)) {
          next.push(value)
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (isRecord(item)) next.push(item)
          }
        }
      }
    }

    if (next.length === 0) return undefined
    current = next
  }

  return undefined
}

/** 展示名：档位已含 Kimi 前缀时不再重复拼接。 */
export function formatKimiPlanName(tierName?: string): string {
  const tier = tierName?.trim()
  if (!tier) return 'Kimi For Coding'
  return /^kimi\b/i.test(tier) ? tier : `Kimi ${tier}`
}
