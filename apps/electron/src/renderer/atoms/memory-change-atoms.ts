import { atom } from 'jotai'
import type { AttributedKnowledgeChange, WorkspaceMemoryFileChange } from '@proma/shared'
import { clearSessionKnowledgeChanges } from '@/lib/session-knowledge-changes'

/** Renderer-lifetime presentation state for the global, current-workspace Memory change dock. */
export const workspaceMemoryChangesAtom = atom<Map<string, WorkspaceMemoryFileChange[]>>(new Map())

/**
 * 授权代际：目录授权/撤销时递增。两种记忆 UI 与缓存都以它为准，
 * 而不是把 accessChanged 混进普通文件变更列表（否则旧 preview/diff 会留在 dock）。
 */
export const workspaceKnowledgeAccessAtom = atom<Map<string, number>>(new Map())

/**
 * 只有主进程核验过的 write/edit 提交才会进这里；按 session 隔离，raw 文件监视不写入。
 * 与 workspaceMemoryChangesAtom 分开：后者仅是无来源的刷新提示。
 */
export const sessionKnowledgeChangesAtom = atom<Map<string, AttributedKnowledgeChange[]>>(new Map())

/** 有界的清理代际水位，不依赖可能过滤归档会话的可见列表。 */
export const blockedKnowledgeRunsAtom = atom<Map<string, number>>(new Map())

export const clearSessionKnowledgeChangesAtom = atom(null, (get, set, input: { sessionId: string; runGeneration?: number }) => {
  const records = get(sessionKnowledgeChangesAtom)
  const previous = get(blockedKnowledgeRunsAtom)
  const floor = Math.max(previous.get(input.sessionId) ?? 0, input.runGeneration ?? 0,
    ...(records.get(input.sessionId) ?? []).map((change) => change.source.runGeneration))
  const next = new Map(previous)
  next.delete(input.sessionId)
  next.set(input.sessionId, floor)
  while (next.size > 500) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  set(blockedKnowledgeRunsAtom, next)
  set(sessionKnowledgeChangesAtom, clearSessionKnowledgeChanges(records, input.sessionId))
})


/** One-shot route from a memory update into WorkspaceMemoryTab. */
export const memoryFileNavigationAtom = atom<{
  workspaceSlug: string
  relativePath: string
  mode: 'preview' | 'edit' | 'change'
} | null>(null)
