import type { AgentWorkspace } from '@proma/shared'

export type BridgeWorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'stale' | 'ambiguous' | 'missing'; configuredId?: string }

export interface BridgeWorkspaceInput {
  /** 按优先级排列的候选（bot 默认 → 应用设置 → 调用方 override）。 */
  candidates: ReadonlyArray<string | undefined>
  exists: (workspaceId: string) => boolean
  list: () => AgentWorkspace[]
}

/**
 * IM 桥接的项目解析：已配置但已删除的项目必须显式拒绝，不能静默漂移到另一个项目，
 * 也不能用空 workspaceId 创建孤儿会话。只有唯一现存项目时才自动采用。
 */
export function resolveBridgeWorkspace(input: BridgeWorkspaceInput): BridgeWorkspaceResolution {
  let configuredId: string | undefined
  for (const candidate of input.candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    configuredId = candidate
    break
  }
  // 只认最高优先级的非空配置：失效即拒绝，不静默降级到另一个项目。
  if (configuredId) return input.exists(configuredId) ? { ok: true, workspaceId: configuredId } : { ok: false, reason: 'stale', configuredId }
  const workspaces = input.list()
  if (workspaces.length === 1 && workspaces[0]) return { ok: true, workspaceId: workspaces[0].id }
  return { ok: false, reason: workspaces.length === 0 ? 'missing' : 'ambiguous' }
}

/** 面向 IM 用户的明确下一步，不替用户创建或切换项目。 */
export function describeBridgeWorkspaceFailure(resolution: Extract<BridgeWorkspaceResolution, { ok: false }>): string {
  if (resolution.reason === 'stale') {
    return `当前配置的项目已不存在（${resolution.configuredId?.slice(0, 8) ?? '未知'}）。请在 Proma 中重新选择项目，或用 /workspace 切换。`
  }
  if (resolution.reason === 'ambiguous') {
    return '当前有多个项目且未指定默认项目。请用 /workspace <序号或名称> 选择项目后再发送消息。'
  }
  return '还没有可用项目。请先在 Proma 中创建项目，再发送消息。'
}
