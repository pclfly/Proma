/**
 * 工作区附加目录列表的跨入口代际。
 *
 * picker、拖拽、移除和初次读取都会产生一个异步响应；只允许最新发起的请求
 * 写入 renderer 列表，避免迟到的旧响应覆盖新列表。后端授权仍以 main 的
 * 持久化结果为准，这里只解决 UI 一致性问题。
 */
export interface WorkspaceDirsRevisions {
  /** 开始一次请求并返回其代际。 */
  begin(workspaceId: string): number
  /** 该代际是否仍是当前最新的请求。 */
  isCurrent(workspaceId: string, revision: number): boolean
}

export function createWorkspaceDirsRevisions(): WorkspaceDirsRevisions {
  const revisions = new Map<string, number>()
  return {
    begin(workspaceId) {
      const next = (revisions.get(workspaceId) ?? 0) + 1
      revisions.set(workspaceId, next)
      return next
    },
    isCurrent(workspaceId, revision) {
      const current = revisions.get(workspaceId)
      return current !== undefined && current === revision
    },
  }
}
