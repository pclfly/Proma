/**
 * 删除定时任务，并连带清理它产生的历史会话。
 *
 * 与官方 0.21.88 的 `automation-deletion-service.ts` 行为一致：
 * 先删任务，再按 `selectDeletableAutomationSessions` 的筛选结果逐条删除会话，
 * 单条失败只计数并继续，不因为一个坏会话把整批回滚。
 *
 * 重要边界：本服务**不会**停止正在运行的会话——忙碌会话已被筛选函数排除在外。
 */

import type { AutomationSessionCandidate } from './automation-session-deletion'
import { selectDeletableAutomationSessions } from './automation-session-deletion'

export interface AutomationDeletionResult {
  /** 是否真的删掉了任务（任务不存在时为 false）。 */
  deleted: boolean
  deletedHistoricalSessionCount: number
  failedHistoricalSessionCount: number
}

export interface AutomationDeletionDeps {
  getAutomation(id: string): { id: string } | undefined
  deleteAutomation(id: string): boolean
  listAgentSessions(): AutomationSessionCandidate[]
  isSessionBusy(sessionId: string): boolean
  deleteSession(sessionId: string): void | Promise<void>
  onSessionDeleteError?(automationId: string, sessionId: string, error: unknown): void
}

export async function deleteAutomationWithHistoricalSessions(
  id: string,
  deps: AutomationDeletionDeps,
): Promise<AutomationDeletionResult> {
  if (!deps.getAutomation(id)) {
    return { deleted: false, deletedHistoricalSessionCount: 0, failedHistoricalSessionCount: 0 }
  }

  const deleted = deps.deleteAutomation(id)

  const sessions = deps.listAgentSessions()
  const busySessionIds = new Set(sessions.filter((session) => deps.isSessionBusy(session.id)).map((session) => session.id))
  const targets = selectDeletableAutomationSessions(sessions, id, busySessionIds)

  let deletedHistoricalSessionCount = 0
  let failedHistoricalSessionCount = 0
  for (const session of targets) {
    try {
      await deps.deleteSession(session.id)
      deletedHistoricalSessionCount++
    } catch (error) {
      failedHistoricalSessionCount++
      deps.onSessionDeleteError?.(id, session.id, error)
    }
  }

  return { deleted, deletedHistoricalSessionCount, failedHistoricalSessionCount }
}
