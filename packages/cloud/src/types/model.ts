/**
 * Cloud 模型与模型目录类型
 *
 * `/models` 返回按供应商分组的模型列表；`/model-catalog` 返回官方渠道快照。
 * 快照结构来自官方 0.22.0 cloud-channel-service 的消费点：
 *   { agent: [{ id, display_name?, ... }], chat?: [{ models: [...] }], defaultAgentModelId? }
 */

/** `/models` 中的单个模型（字段按后端扩展） */
export interface CloudModelInfo {
  id: string
  name?: string
  display_name?: string
  enabled?: boolean
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  apiProtocol?: string
  chatSortOrder?: number
  metadata?: CloudModelMetadata
  [key: string]: unknown
}

export interface CloudModelMetadata {
  modelListHint?: string
  modelPriceTooltip?: unknown
  [key: string]: unknown
}

/** `/models` 按供应商分组的单项 */
export interface CloudModelProviderGroup {
  provider?: string
  providerName?: string
  name?: string
  models: CloudModelInfo[]
  [key: string]: unknown
}

export interface CloudModelsEnvelope {
  providers?: unknown
  models?: unknown
  [key: string]: unknown
}

/** 官方渠道模型目录中的 chat 分组 */
export interface CloudChatModelGroup {
  models: CloudModelInfo[]
  [key: string]: unknown
}

/** 官方渠道模型目录快照 */
export interface CloudModelCatalogSnapshot {
  agent: CloudModelInfo[]
  chat?: CloudChatModelGroup[]
  defaultAgentModelId?: string
  [key: string]: unknown
}

/**
 * 校验官方模型目录快照。
 *
 * 与官方 `isOfficialModelCatalogSnapshot` 等价：
 * - agent 必须是数组，且每一项 id 为非空字符串；
 * - display_name 若存在必须是字符串；
 * - chat 若存在必须是数组。
 * 注意：官方实现不校验 chat 内部结构，这里保持一致。
 */
export function isCloudModelCatalogSnapshot(value: unknown): value is CloudModelCatalogSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  if (!Array.isArray(snapshot.agent)) return false
  const agentValid = snapshot.agent.every((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const model = item as Record<string, unknown>
    return (
      typeof model.id === 'string'
      && model.id.trim().length > 0
      && (model.display_name === undefined || typeof model.display_name === 'string')
    )
  })
  return agentValid && (snapshot.chat === undefined || Array.isArray(snapshot.chat))
}

/** 选择默认 Agent 模型：仅当该 id 确实存在于 agent 目录中才返回。 */
export function getCloudCatalogDefaultAgentModel(
  snapshot: CloudModelCatalogSnapshot,
): string | undefined {
  const candidate = snapshot.defaultAgentModelId
  return typeof candidate === 'string' && snapshot.agent.some((model) => model.id === candidate)
    ? candidate
    : undefined
}

/**
 * 归一化 `/models` 的供应商分组。
 *
 * 兼容三种载荷：数组、{ providers: [...] }、{ models: [...] }。
 * 非法项直接丢弃，保证未登录/空目录时返回空数组而不是抛错。
 */
export function normalizeCloudModelProviderGroups(payload: unknown): CloudModelProviderGroup[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (payload as CloudModelsEnvelope).providers ?? (payload as CloudModelsEnvelope).models
      : undefined
  if (!Array.isArray(candidates)) return []
  return candidates.filter((item): item is CloudModelProviderGroup => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const group = item as CloudModelProviderGroup
    return Array.isArray(group.models)
  })
}
