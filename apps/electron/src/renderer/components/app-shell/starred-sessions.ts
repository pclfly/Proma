/**
 * 侧边栏「收藏」视图的纯过滤逻辑。
 *
 * 收藏（星标）与归档是正交的两件事：
 * - 星标只是视觉标记，不改变归档状态（见 agent-session-manager 的 isStarredOnly）
 * - 收藏视图展示全部星标会话，包括已归档的——用户加星的目的就是"回头能找到"
 *
 * 因此这里不去读归档状态，也不修改任何会话数据，只做展示层筛选。
 */

import type { AgentSessionMeta } from '@proma/shared'

export interface StarredViewOptions {
  /** 正在删除的会话，避免删除动画期间闪回。 */
  pendingDeleteId?: string
  /** 草稿会话不属于"收藏"，即使被标星也不展示。 */
  draftSessionIds?: ReadonlySet<string>
}

/**
 * 从全部会话中挑出收藏视图要展示的项。
 *
 * 排序规则：置顶优先，其次按更新时间倒序，与活跃视图保持一致，
 * 避免用户在两个视图之间感到顺序突变。
 */
export function selectStarredSessions(
  sessions: readonly AgentSessionMeta[],
  options: StarredViewOptions = {},
): AgentSessionMeta[] {
  const { pendingDeleteId, draftSessionIds } = options
  const starred = sessions.filter((session) => (
    session.starred === true
    && !session.isDraft
    && !(draftSessionIds?.has(session.id) ?? false)
    && session.id !== pendingDeleteId
  ))
  return starred.sort((left, right) => {
    const byPinned = Number(right.pinned === true) - Number(left.pinned === true)
    if (byPinned !== 0) return byPinned
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  })
}

/** 收藏视图是否需要额外加载归档列表：已归档的星标会话也要能看到。 */
export function starredViewNeedsArchived(includeArchived: boolean): boolean {
  return includeArchived
}
