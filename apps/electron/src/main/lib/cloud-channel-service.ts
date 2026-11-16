/**
 * Cloud 官方渠道服务（纯逻辑部分）
 *
 * 合并官方 0.22.0 的两个模块：
 * - `src/main/lib/official-model-catalog.ts`（快照校验 / 默认模型）
 * - `src/main/lib/official-channel-models.ts`（启用状态保留 / 锁定校验）
 * 并移植 `cloud-channel-service.ts` 中无副作用的目录转换：
 * `flattenOfficialChatModels`、`mapOfficialAgentModels`。
 *
 * 明确 deferred：
 * - system API key 获取与轮换
 * - `/model-catalog` ETag 增量同步、轮询与渠道写回
 * - modelPriceTooltip 归一化（官方 `normalizeModelPriceTooltip` 未在 bundle 中保留纯函数体）
 */

import type {
  CloudChatModelGroup,
  CloudModelCatalogSnapshot,
  CloudModelInfo,
  CloudModelMetadata,
} from '@proma/cloud'
import {
  getCloudCatalogDefaultAgentModel,
  isCloudModelCatalogSnapshot,
} from '@proma/cloud'
import type { CloudServiceResult } from './cloud-service-types'

/** 官方渠道目录锁定文案（与官方一致） */
export const OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE = 'Proma Cloud 渠道的模型目录由 Proma 管理，无法编辑'

/** 官方渠道模型（可由 `/model-catalog` 或 `/models` 生成） */
export interface OfficialChannelModel {
  id: string
  name: string
  enabled: boolean
  apiProtocol?: string
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  modelListHint?: string
  [key: string]: unknown
}

/** 快照类型别名，便于主进程只依赖本模块 */
export type OfficialModelCatalogSnapshot = CloudModelCatalogSnapshot

/** 官方 fast-path：快照校验（复用 @proma/cloud 单一实现） */
export const isOfficialModelCatalogSnapshot = isCloudModelCatalogSnapshot

/** 官方默认 Agent 模型（仅当 id 存在于目录中） */
export const getCatalogDefaultAgentModel = getCloudCatalogDefaultAgentModel

function getModelListHint(metadata: CloudModelMetadata | undefined): string | undefined {
  const hint = metadata?.modelListHint
  return typeof hint === 'string' && hint.trim() ? hint.trim() : undefined
}

/**
 * 将 chat 分组拍平并按 chatSortOrder 排序。
 *
 * 排序规则与官方一致：
 * - 两者都有排序号 → 按序号，再按 id；
 * - 只有一方有排序号 → 有排序号者优先；
 * - 都没有 → 保持原分组/模型顺序。
 */
export function flattenOfficialChatModels(groups: CloudChatModelGroup[]): OfficialChannelModel[] {
  const models = groups.flatMap((group, groupIndex) => (
    (group.models ?? []).map((model, modelIndex) => ({
      model,
      sourceIndex: groupIndex * 1_000_000 + modelIndex,
    }))
  ))

  return models
    .sort((a, b) => {
      const aOrder = a.model.chatSortOrder
      const bOrder = b.model.chatSortOrder
      if (typeof aOrder === 'number' && typeof bOrder === 'number') {
        return aOrder - bOrder || a.model.id.localeCompare(b.model.id)
      }
      if (typeof aOrder === 'number') return -1
      if (typeof bOrder === 'number') return 1
      return a.sourceIndex - b.sourceIndex
    })
    .map(({ model }) => {
      const modelListHint = getModelListHint(model.metadata)
      return {
        id: model.id,
        // 正常目录一定带 name；缺失时回退 id，避免下游出现 undefined。
        name: typeof model.name === 'string' ? model.name : model.id,
        enabled: true,
        ...(modelListHint ? { modelListHint } : {}),
      }
    })
}

/**
 * 将 `/model-catalog` 的 agent 目录转换为渠道模型。
 *
 * 与官方一致保留协议/上下文/输出上限与 modelListHint；
 * modelPriceTooltip 归一化 deferred，当前不写入。
 */
export function mapOfficialAgentModels(items: CloudModelInfo[]): OfficialChannelModel[] {
  return items.map((item) => ({
    id: item.id,
    name: item.display_name || item.id,
    enabled: true,
    ...(item.apiProtocol ? { apiProtocol: item.apiProtocol } : {}),
    ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
    ...(item.maxInputTokens ? { maxInputTokens: item.maxInputTokens } : {}),
    ...(item.maxOutputTokens ? { maxOutputTokens: item.maxOutputTokens } : {}),
    ...(typeof item.modelListHint === 'string' && item.modelListHint.trim()
      ? { modelListHint: item.modelListHint.trim() }
      : {}),
  }))
}

/**
 * 用户手动切换官方渠道模型启用状态时的校验。
 *
 * 官方要求请求模型集合与现有集合 id 完全一致（数量 + 唯一性），
 * 否则抛锁定错误，避免通过保存渠道配置改写官方目录。
 */
export function applyOfficialModelEnabledStates<T extends { id: string; enabled: boolean }>(
  existingModels: T[],
  requestedModels: Array<{ id: string; enabled: boolean }>,
): T[] {
  const requestedById = new Map(requestedModels.map((model) => [model.id, model]))
  if (requestedById.size !== requestedModels.length || requestedById.size !== existingModels.length) {
    throw new Error(OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE)
  }
  return existingModels.map((model) => {
    const requested = requestedById.get(model.id)
    if (!requested) throw new Error(OFFICIAL_MODEL_CATALOG_LOCKED_MESSAGE)
    return { ...model, enabled: requested.enabled }
  })
}

/** 目录刷新时保留用户已有的启用状态；新模型使用目录默认值。 */
export function preserveOfficialModelEnabledStates<T extends { id: string; enabled: boolean }>(
  catalogModels: T[],
  persistedModels: Array<{ id: string; enabled: boolean }> = [],
): T[] {
  const enabledById = new Map(persistedModels.map((model) => [model.id, model.enabled]))
  return catalogModels.map((model) => ({
    ...model,
    enabled: enabledById.get(model.id) ?? model.enabled,
  }))
}

/** 旧配置迁移：incoming 缺失时直接沿用 existing。 */
export function resolveLegacyOfficialModels<T extends { id: string; enabled: boolean }>(
  incoming: T[] | undefined,
  existing: T[] = [],
): T[] {
  return incoming === undefined ? existing : preserveOfficialModelEnabledStates(incoming, existing)
}

/** 官方渠道服务类型契约；实现留给后续批次。 */
export interface CloudChannelService {
  refreshOfficialModels(): Promise<CloudServiceResult<{ changed: boolean }>>
  getSystemApiKey(): Promise<string>
}
