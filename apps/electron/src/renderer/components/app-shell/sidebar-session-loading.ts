import type { AgentSessionMeta } from '@proma/shared'

export interface SidebarSessionsApi {
  listActiveAgentSessions(): Promise<AgentSessionMeta[]>
  listArchivedAgentSessions(): Promise<AgentSessionMeta[]>
  countArchivedAgentSessions(): Promise<number>
}

/** 计数是附加信息，不得阻塞活跃/归档列表。返回的请求代际防止快速切换回写旧视图。 */
export function createSidebarSessionLoader(api: SidebarSessionsApi, applySessions: (sessions: AgentSessionMeta[]) => void, applyCount: (count: number | null) => void) {
  let generation = 0
  return async (includeArchived: boolean): Promise<void> => {
    const current = ++generation
    void api.countArchivedAgentSessions().then((count) => {
      if (current === generation) applyCount(count)
    }).catch(() => { if (current === generation) applyCount(null) })
    const [active, archived] = await Promise.all([
      api.listActiveAgentSessions(),
      includeArchived ? api.listArchivedAgentSessions() : Promise.resolve([]),
    ])
    if (current === generation) applySessions([...active, ...archived])
  }
}

export function shouldShowSessionPin(showPinIcon: boolean | undefined, starred?: boolean): boolean {
  return !!showPinIcon && !starred
}
