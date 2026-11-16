/**
 * 删除定时任务时，挑选可以连带删除的历史会话。
 *
 * 与官方 0.21.88 的 `automation-session-deletion.ts` 语义一致：
 *
 * 1. 只选 `sourceAutomationId === 目标任务` 的会话。
 * 2. 通过 `parentSessionId` 把会话连成无向连通分量，只要分量里**任一**会话
 *    正在运行或已被提升为普通会话（`automationGraduated`），整个分量都受保护。
 * 3. 受保护的分量一个都不删——宁可留下，也不误删用户可能正在用或已接管的历史。
 *
 * 这个函数是纯函数，不读写磁盘，便于直接测试边界。
 */

export interface AutomationSessionCandidate {
  id: string
  sourceAutomationId?: string
  parentSessionId?: string
  /** 已被用户提升为普通会话；这类会话不再属于任务的生命周期。 */
  automationGraduated?: boolean
}

/**
 * 返回可以随任务一起删除的会话。
 *
 * @param sessions 全部会话（不需要预先过滤）
 * @param automationId 即将删除的任务 id
 * @param busySessionIds 当前正在运行的会话 id 集合
 */
export function selectDeletableAutomationSessions<T extends AutomationSessionCandidate>(
  sessions: readonly T[],
  automationId: string,
  busySessionIds: ReadonlySet<string>,
): T[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const adjacent = new Map<string, Set<string>>(sessions.map((session) => [session.id, new Set<string>()]))

  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId || !byId.has(parentId)) continue
    adjacent.get(session.id)?.add(parentId)
    adjacent.get(parentId)?.add(session.id)
  }

  const protectedIds = new Set<string>()
  const visited = new Set<string>()

  for (const start of sessions) {
    if (visited.has(start.id)) continue
    const component: T[] = []
    const pending: string[] = [start.id]
    visited.add(start.id)
    while (pending.length > 0) {
      const currentId = pending.pop()!
      const current = byId.get(currentId)
      if (current) component.push(current)
      for (const neighbour of adjacent.get(currentId) ?? []) {
        if (visited.has(neighbour)) continue
        visited.add(neighbour)
        pending.push(neighbour)
      }
    }
    const hasProtected = component.some((item) => busySessionIds.has(item.id) || item.automationGraduated === true)
    if (hasProtected) {
      for (const item of component) protectedIds.add(item.id)
    }
  }

  return sessions.filter(
    (session) => session.sourceAutomationId === automationId && !protectedIds.has(session.id),
  )
}
