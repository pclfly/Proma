/**
 * Agent 会话删除的运行时资源清理。
 *
 * 顺序是语义的一部分：
 * 1. 先 tombstone 并 drain，阻止 headless/委派运行在 preflight 中重新创建 transcript；
 * 2. 清理权限、AskUser、ExitPlan 与排队消息；
 * 3. 关闭浏览器与终端；
 * 4. 删除会话索引/文件，最后释放附件监听。
 */

import { browserController } from './browser-controller'
import { closeTerminalsForSession } from './terminal-service'
import { deleteAgentSession, getAgentSessionMeta } from './agent-session-manager'
import { clearAgentQueuedMessages, stopAgentAndDrain } from './agent-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { permissionService } from './agent-permission-service'
import {
  releaseAttachedFileWatchers,
  releaseDirectoryWatcherIfUnreferenced,
} from './agent-attachment-watcher-release'

export interface AgentSessionDeletionDeps {
  getAgentSessionMeta: typeof getAgentSessionMeta
  stopAgentAndDrain: typeof stopAgentAndDrain
  clearPermissionWhitelist: typeof permissionService.clearSessionWhitelist
  clearPermissionPending: typeof permissionService.clearSessionPending
  clearAskUserPending: typeof askUserService.clearSessionPending
  clearExitPlanPending: typeof exitPlanService.clearSessionPending
  clearQueuedMessages: typeof clearAgentQueuedMessages
  closeBrowser: typeof browserController.close
  closeTerminals: typeof closeTerminalsForSession
  deleteAgentSession: typeof deleteAgentSession
  releaseAttachedFileWatchers: typeof releaseAttachedFileWatchers
  releaseDirectoryWatcherIfUnreferenced: typeof releaseDirectoryWatcherIfUnreferenced
}

const defaultDeps: AgentSessionDeletionDeps = {
  getAgentSessionMeta,
  stopAgentAndDrain,
  clearPermissionWhitelist: (id) => permissionService.clearSessionWhitelist(id),
  clearPermissionPending: (id) => permissionService.clearSessionPending(id),
  clearAskUserPending: (id) => askUserService.clearSessionPending(id),
  clearExitPlanPending: (id) => exitPlanService.clearSessionPending(id),
  clearQueuedMessages: clearAgentQueuedMessages,
  closeBrowser: (id) => browserController.close(id),
  closeTerminals: closeTerminalsForSession,
  deleteAgentSession,
  releaseAttachedFileWatchers,
  releaseDirectoryWatcherIfUnreferenced,
}

export async function deleteAgentSessionWithRuntimeResources(
  id: string,
  overrides: Partial<AgentSessionDeletionDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides }
  const session = deps.getAgentSessionMeta(id)
  const attachedFiles = session?.attachedFiles
  const attachedDirectories = session?.attachedDirectories
  await deps.stopAgentAndDrain(id)
  deps.clearPermissionWhitelist(id)
  deps.clearPermissionPending(id)
  deps.clearAskUserPending(id)
  deps.clearExitPlanPending(id)
  deps.clearQueuedMessages(id)
  await deps.closeBrowser(id)
  deps.closeTerminals(id)
  deps.deleteAgentSession(id)
  deps.releaseAttachedFileWatchers(attachedFiles)
  for (const directoryPath of new Set(attachedDirectories ?? [])) {
    deps.releaseDirectoryWatcherIfUnreferenced(directoryPath)
  }
}
