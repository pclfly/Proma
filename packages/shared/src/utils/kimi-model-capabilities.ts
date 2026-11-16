/**
 * Kimi 模型能力与渠道预置 — 单一 source of truth。
 *
 * 与官方 0.21.92 的 `packages/shared/src/utils/kimi-model-capabilities.ts` 对齐：
 * - 官方目录使用 1,048,576（K3.1 Pro / Kimi for Coding）与 262,144（K3 256K）；
 * - kimi-api 使用 `kimi-` 前缀，kimi-coding 使用无前缀的 K3.1 模型 ID；
 * - 上下文推断、模型注册与渠道预置都必须复用这里的判定，避免 UI 与运行时口径不一致。
 */

/** K3.1 Pro / Kimi for Coding 的上下文窗口（官方目录值，非十进制 1e6）。 */
export const KIMI_K3_1_CONTEXT_WINDOW = 1_048_576

/** K3 256K / Coding Highspeed 的上下文窗口。 */
export const KIMI_K3_256K_CONTEXT_WINDOW = 262_144

/** 归一化模型 ID：去空白、小写、去 `[1m]` 尾缀。 */
export function normalizeKimiModelId(modelId: string | undefined): string {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/, '') ?? ''
}

/**
 * K3.1 Pro（含 highspeed）判定。
 *
 * 同时兼容 kimi-api 的 `kimi-k3.1-pro` 与 kimi-coding 的 `k3.1-pro`；
 * 不匹配本地 reasoning profile 的 `kimi-k3.1-api` / `kimi-k3.1-coding` 别名，
 * 那两者由 reasoning-profile 自身处理。
 */
export function isKimiK31Model(modelId: string | undefined): boolean {
  return /^(?:kimi-)?k3\.1-pro(?:-highspeed)?$/.test(normalizeKimiModelId(modelId))
}

/**
 * Kimi 渠道的上下文窗口。
 *
 * 官方目录中 K3.1 Pro / kimi-for-coding 为 1,048,576；K3 256K 与
 * Coding Highspeed 为 262,144。未识别的 Kimi 模型交回通用推断，
 * 避免把整个 K3 家族统一放大到 1M。
 */
export function getKimiContextWindow(modelId: string | undefined): number | undefined {
  const id = normalizeKimiModelId(modelId)
  if (isKimiK31Model(id) || id === 'kimi-for-coding') return KIMI_K3_1_CONTEXT_WINDOW
  if (id === 'k3-256k' || id === 'kimi-for-coding-highspeed') return KIMI_K3_256K_CONTEXT_WINDOW
  return undefined
}

export interface KimiModelPreset {
  id: string
  name: string
  enabled: boolean
}

/**
 * 渠道预置模型。
 *
 * kimi-api 走 `kimi-` 前缀；kimi-coding 走无前缀的 K3.1 ID，并额外提供
 * `kimi-for-coding` 作为兼容入口。
 */
export function getKimiModelPresets(provider: string): KimiModelPreset[] {
  const prefix = provider === 'kimi-api' ? 'kimi-' : ''
  const presets: KimiModelPreset[] = [
    { id: `${prefix}k3.1-pro`, name: 'Kimi K3.1 Pro', enabled: true },
    { id: `${prefix}k3.1-pro-highspeed`, name: 'Kimi K3.1 Pro Highspeed', enabled: false },
    { id: `${prefix}k3`, name: 'Kimi K3', enabled: true },
  ]
  // kimi-k2.6 已停售，不再进入新建渠道预置；存量渠道的模型配置不受影响。
  if (provider !== 'kimi-api') {
    presets.push({ id: 'kimi-for-coding', name: 'Kimi for Coding', enabled: true })
  }
  return presets
}
