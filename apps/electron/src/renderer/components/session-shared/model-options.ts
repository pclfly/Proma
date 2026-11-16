/** 共享模型选择的纯逻辑；未指定过滤与显式空过滤具有不同语义。 */
import type { Channel, ModelOption, ProviderType } from '@proma/shared'

export interface ModelSelection { channelId: string; modelId: string }

export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
): ModelOption[] {
  const options: ModelOption[] = []

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (filterChannelIds && !filterChannelIds.includes(channel.id)) continue
    if (excludedProviders?.includes(channel.provider)) continue

    for (const model of channel.models) {
      if (!model.enabled) continue

      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      })
    }
  }

  return options
}

export function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>()

  for (const option of options) {
    const key = option.channelId
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }

  return groups
}

/** 只为同一显式选择复用缓存，不把null/另一选择显示成先前模型。 */
export function getDisplayModelInfo(selected: ModelSelection | null, current: ModelOption | null, cached: ModelOption | null): ModelOption | null {
  if (!selected) return null
  for (const option of [current, cached]) {
    if (option?.channelId === selected.channelId && option.modelId === selected.modelId) return option
  }
  return null
}
