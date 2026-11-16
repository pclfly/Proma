import { inferCorrectedGPTContextWindow, inferKnownContextWindow, type ChannelModel } from '@proma/shared'

export function getBuiltInContextWindow(model: ChannelModel): number | undefined {
  return inferCorrectedGPTContextWindow(model.id) ?? model.builtInContextWindow ?? inferKnownContextWindow(model.id)
}

export function formatBuiltInContextWindow(value: number | undefined): string {
  if (value === undefined) return '上下文未知'
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return value.toLocaleString('en-US')
}

/** 只在启用且没有手动覆盖时填充，取消启用不会丢失设置。 */
export function enableChannelModel(model: ChannelModel): ChannelModel {
  const contextWindow = model.contextWindow ?? getBuiltInContextWindow(model)
  return { ...model, enabled: true, ...(contextWindow !== undefined ? { contextWindow } : {}) }
}

export function mergeFetchedChannelModels(
  previous: ChannelModel[],
  fetched: ChannelModel[],
  autoEnable: boolean,
): ChannelModel[] {
  const fetchedIds = new Set(fetched.map((model) => model.id))
  const previousById = new Map(previous.map((model) => [model.id, model]))
  const manualKept = previous.filter((model) => model.source === 'manual' && !fetchedIds.has(model.id))
  const merged = fetched.map((model) => {
    const old = previousById.get(model.id)
    const next = {
      ...model,
      source: old?.source ?? 'fetched' as const,
      enabled: autoEnable || old?.enabled === true,
      ...(old?.contextWindow !== undefined ? { contextWindow: old.contextWindow } : {}),
    }
    // 已启用项可能被用户明确清空以使用自动模式；刷新不重新写入覆盖值。
    return next.enabled && !old?.enabled ? enableChannelModel(next) : next
  })
  return [...manualKept, ...merged]
}
