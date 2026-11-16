/**
 * ChatGPT Codex 渠道的模型准入策略。
 *
 * 官方 0.21.92 将 Codex 模型从“黑名单排除”改为固定白名单：只有已验证的
 * GPT-5.6 Terra / GPT-6 Astra/Sol/Luna / GPT-6.1 Sol/Terra 允许出现在
 * openai-codex 渠道中。这里保持官方白名单；本地扩展的 Astra SKU 变体
 * （如 `gpt-6-astra-fast`）由调用方用 model-family 额外放行。
 */

import type { ChannelsConfig } from '@proma/shared'
import { isGpt61TerraFamily, isGpt6AstraFamily } from '@proma/shared'

const ALLOWED_CODEX_MODEL_IDS = new Set([
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
])

/** 归一化 Codex 模型 ID：去空白、小写、去 `[1m]` 尾缀。 */
export function normalizeCodexModelId(modelId: string | undefined): string | undefined {
  const normalized = modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  return normalized || undefined
}

/** 是否属于官方允许的 Codex 模型（精确匹配，不接受近似 ID）。 */
export function isCodexModelAllowed(modelId: string | undefined): boolean {
  const normalized = normalizeCodexModelId(modelId)
  return normalized !== undefined && ALLOWED_CODEX_MODEL_IDS.has(normalized)
}

/**
 * 渠道/运行时实际准入判定。
 *
 * 在官方白名单之外保留本地已验证的 Astra SKU 变体与 GPT-6.1 Terra -1 入口，
 * 避免官方精确白名单误删 custom/proma 已支持的模型。
 */
export function isManagedCodexModelAllowed(modelId: string | undefined): boolean {
  return isCodexModelAllowed(modelId) || isGpt6AstraFamily(modelId) || isGpt61TerraFamily(modelId)
}

export interface CodexModelFilterResult {
  config: ChannelsConfig
  changed: boolean
}

/**
 * 清理 openai-codex 渠道中的非白名单模型。
 *
 * 只处理 openai-codex，其他渠道原样保留；模型 ID 会被归一化，已经是干净 ID
 * 的模型对象保持引用不变，避免无意义的配置回写。
 */
export function filterManagedCodexChannelModels(config: ChannelsConfig): CodexModelFilterResult {
  let changed = false
  const channels = config.channels.map((channel) => {
    if (channel.provider !== 'openai-codex') return channel
    const models = channel.models.flatMap((model) => {
      const normalizedId = normalizeCodexModelId(model.id)
      if (!normalizedId || !isManagedCodexModelAllowed(normalizedId)) return []
      return normalizedId === model.id ? [model] : [{ ...model, id: normalizedId }]
    })
    if (models.length === channel.models.length && models.every((model, index) => model === channel.models[index])) {
      return channel
    }
    changed = true
    return { ...channel, models }
  })
  return changed ? { config: { ...config, channels }, changed: true } : { config, changed: false }
}
