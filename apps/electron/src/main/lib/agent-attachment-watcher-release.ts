/**
 * Agent 附件/目录监听释放。
 *
 * 删除会话或工作区时，只有仍未被其他工作区/会话引用时才停止 fs.watch，
 * 避免释放其他会话共享的目录监听。
 */

import { dirname } from 'node:path'
import {
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  listAgentWorkspaces,
} from './agent-workspace-manager'
import { listAgentSessions } from './agent-session-manager'
import { unwatchAttachedDirectory } from './workspace-watcher'

export function releaseDirectoryWatcherIfUnreferenced(dirPath: string): void {
  const isStillReferenced = listAgentWorkspaces().some((workspace) =>
    workspace.projectRootPath === dirPath
    || getWorkspaceAttachedDirectories(workspace.slug).includes(dirPath)
    || getWorkspaceAttachedFiles(workspace.slug).some((filePath) => dirname(filePath) === dirPath),
  ) || listAgentSessions().some((session) =>
    session.attachedDirectories?.includes(dirPath)
    || session.attachedFiles?.some((filePath) => dirname(filePath) === dirPath),
  )

  if (!isStillReferenced) unwatchAttachedDirectory(dirPath)
}

export function releaseAttachedFileWatchers(filePaths: readonly string[] | undefined): void {
  for (const dirPath of new Set((filePaths ?? []).map((filePath) => dirname(filePath)))) {
    releaseDirectoryWatcherIfUnreferenced(dirPath)
  }
}
