type PolicyListener = () => void
const listeners = new Map<string, Set<PolicyListener>>()

/** 仅传播授权事实变更，不含路径正文，不建立第二套持久权限。 */
export function subscribeWorkspaceKnowledgePolicyChanges(workspaceSlug: string, callback: PolicyListener): () => void {
  const current = listeners.get(workspaceSlug) ?? new Set<PolicyListener>()
  listeners.set(workspaceSlug, current)
  current.add(callback)
  return () => { current.delete(callback); if (current.size === 0 && listeners.get(workspaceSlug) === current) listeners.delete(workspaceSlug) }
}

/** 持久化成功后同步清理watcher旧权限/正文，再由接收方按当前权限重建。 */
export function notifyWorkspaceKnowledgePolicyChanged(workspaceSlug: string): void {
  for (const callback of [...(listeners.get(workspaceSlug) ?? [])]) {
    try { callback() } catch (error) { console.warn('[工作区知识] 权限刷新回调失败:', error) }
  }
}
