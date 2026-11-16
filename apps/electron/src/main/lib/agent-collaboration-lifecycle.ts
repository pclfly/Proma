import type { AgentDelegationStatus, SDKMessage } from '@proma/shared'

export interface AgentRunLifecycleEvent {
  sessionId: string
  identity: AgentRunIdentity
  completion?: AgentRunCompletion
}

const activeRuns = new Map<string, AgentRunIdentity>()
const listeners = new Set<(event: AgentRunLifecycleEvent) => void>()

export function listActiveAgentRuns(): Array<AgentRunIdentity & { sessionId: string }> {
  return [...activeRuns].map(([sessionId, identity]) => ({ sessionId, ...identity }))
}

export function getActiveAgentRun(sessionId: string): AgentRunIdentity | undefined {
  return activeRuns.get(sessionId)
}

export function onAgentRunLifecycle(listener: (event: AgentRunLifecycleEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notify(event: AgentRunLifecycleEvent): void {
  for (const listener of listeners) {
    try { listener(event) } catch (error) { console.error('[协作生命周期] 状态同步失败:', error) }
  }
}

export function publishAgentRunAccepted(sessionId: string, identity: AgentRunIdentity): void {
  const current = activeRuns.get(sessionId)
  if (current && current.runGeneration >= identity.runGeneration) return
  activeRuns.set(sessionId, identity)
  notify({ sessionId, identity })
}

export function publishAgentRunSettled(sessionId: string, identity: AgentRunIdentity, completion: AgentRunCompletion): void {
  const current = activeRuns.get(sessionId)
  if (current?.runGeneration !== identity.runGeneration) return
  activeRuns.delete(sessionId)
  notify({ sessionId, identity, completion })
}

export interface AgentRunIdentity {
  startedAt: number
  runGeneration: number
}

export interface AgentRunCompletion {
  stoppedByUser?: boolean
  startedAt?: number
  runGeneration?: number
  error?: string
  resultSubtype?: string
  resultErrors?: string[]
  finalAssistantUuid?: string
  backgroundTasksPending?: boolean
}

export function classifyDelegationCompletion(result: AgentRunCompletion): AgentDelegationStatus {
  if (result.stoppedByUser) return 'cancelled'
  if (result.error || result.resultErrors?.length || result.resultSubtype?.startsWith('error') || result.resultSubtype === 'empty_response') return 'failed'
  return result.resultSubtype === 'success' ? 'completed' : 'interrupted'
}

function assistantText(message: SDKMessage): string | undefined {
  const record = message as unknown as Record<string, unknown>
  if (record.type !== 'assistant' || record.isReplay || record._partial || record.error || record._errorCode) return undefined
  const inner = record.message as { content?: Array<{ type?: string; text?: string }> } | undefined
  if (!Array.isArray(inner?.content)) return undefined
  return inner.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n\n').trim() || undefined
}

/** 仅保存当轮最终正文的定位信息，避免在会话索引和 IPC 中复制大段历史。 */
export function getFinalAssistantUuid(message: SDKMessage): string | undefined {
  if (!assistantText(message)) return undefined
  const uuid = (message as unknown as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : undefined
}

export function getAssistantSummary(messages: SDKMessage[], uuid: string | undefined): string | undefined {
  if (!uuid) return undefined
  const message = messages.findLast((item) => (item as unknown as { uuid?: string }).uuid === uuid)
  return message ? assistantText(message) : undefined
}
