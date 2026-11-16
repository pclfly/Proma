import type { AttributedKnowledgeChange } from '@proma/shared'

export const MAX_SESSION_KNOWLEDGE_CHANGES = 20
export const MAX_KNOWLEDGE_SESSIONS = 100

export interface KnowledgeChangeEventInput {
  /** Agent Stream 外层会话；必须与凭据来源一致，否则不归属任何会话。 */
  sessionId: string
  change: AttributedKnowledgeChange
  /** 该会话当前已知的运行代际；旧代次迟到事件不得进入来源列表。 */
  activeRunGeneration?: number
  /** 清理前的最后代际：迟到事件不得复活已清理记录，新运行可重新建立来源。 */
  blockedRunGeneration?: number
}

/**
 * 只接收主进程核验过的来源事件：
 * - 外层会话必须等于 change.source.sessionId，绝不回落到当前会话；
 * - 同 changeId 去重，重复投递不累积；
 * - 旧 runGeneration 的迟到事件丢弃，新代际正常接收。
 */
export function applySessionKnowledgeChange(
  previous: Map<string, AttributedKnowledgeChange[]>,
  input: KnowledgeChangeEventInput,
): Map<string, AttributedKnowledgeChange[]> {
  const { sessionId, change, activeRunGeneration, blockedRunGeneration } = input
  if (blockedRunGeneration != null && change.source.runGeneration <= blockedRunGeneration) return previous
  if (!change.changeId || change.source.sessionId !== sessionId) return previous
  if (activeRunGeneration != null && change.source.runGeneration < activeRunGeneration) return previous
  const existing = previous.get(sessionId) ?? []
  if (existing.some(item => item.changeId === change.changeId)) return previous
  const next = [change, ...existing].slice(0, MAX_SESSION_KNOWLEDGE_CHANGES)
  const updated = new Map(previous)
  updated.delete(sessionId)
  updated.set(sessionId, next)
  while (updated.size > MAX_KNOWLEDGE_SESSIONS) {
    const oldest = updated.keys().next().value
    if (oldest === undefined) break
    updated.delete(oldest)
  }
  return updated
}

export function listSessionKnowledgeChanges(
  source: Map<string, AttributedKnowledgeChange[]>,
  sessionId: string | null | undefined,
): AttributedKnowledgeChange[] {
  // 未知/未选中会话不得借用其它会话或默认项目的 diff。
  return sessionId ? source.get(sessionId) ?? [] : []
}

export function clearSessionKnowledgeChanges(
  previous: Map<string, AttributedKnowledgeChange[]>,
  sessionId: string,
): Map<string, AttributedKnowledgeChange[]> {
  if (!previous.has(sessionId)) return previous
  const updated = new Map(previous)
  updated.delete(sessionId)
  return updated
}

/** 展示用标题：区分协作记忆文件与两份规则文件。 */
export function describeKnowledgeTarget(change: AttributedKnowledgeChange): string {
  switch (change.file.kind) {
    case 'memory': return `协作记忆 · ${change.file.relativePath}`
    case 'workspace_agents': return 'Proma 工作区规则 · AGENTS.md'
    case 'project_agents': return '项目规则 · AGENTS.md'
  }
}
