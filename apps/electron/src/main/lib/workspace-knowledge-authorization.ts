import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import { getKnownKnowledgeWorkspace } from './agent-workspace-manager'

export interface KnowledgeDirectoryGrantResult {
  status: 'authorized' | 'cancelled'
  path?: string
  directories?: string[]
}

function canonicalDirectory(selected: string): string {
  try {
    const canonical = realpathSync(selected)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    throw new Error('所选路径不是可访问的普通目录，未授权任何目录')
  }
}

function assertGrantContext(workspaceSlug: string, workspaceId: string, parent: BrowserWindow | null, validateActor: () => void): void {
  validateActor()
  if (parent?.isDestroyed() || getKnownKnowledgeWorkspace(workspaceSlug).id !== workspaceId) {
    throw new Error('授权期间窗口或工作区已变化，未授权任何目录')
  }
}

/** main自行打开原生选择器；renderer只提交workspaceSlug意图，不提交选择结果。 */
export async function authorizeWorkspaceKnowledgeDirectory(
  workspaceSlug: string,
  parent: BrowserWindow | null,
  attach: (workspaceSlug: string, directoryPath: string) => string[],
  validateActor: () => void = () => {},
): Promise<KnowledgeDirectoryGrantResult> {
  // 捕获注册身份，防止选择期间同slug被删除重建；未知工作区不创建或迁移。
  const workspace = getKnownKnowledgeWorkspace(workspaceSlug)
  assertGrantContext(workspaceSlug, workspace.id, parent, validateActor)
  const options: Electron.OpenDialogOptions = {
    properties: ['openDirectory'],
    title: `授权工作区「${workspace.name}」的外置目录`,
    message: '该目录会成为工作区附加目录，Agent与记忆外置链接也能访问；不会批准维护AGENTS.md。撤销不会删除文件。',
    buttonLabel: '授权访问',
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { status: 'cancelled' }
  const selected = result.filePaths[0]!
  // 用户确认后先重验actor/注册身份，再访问所选路径；记录canonical目录而非别名。
  assertGrantContext(workspaceSlug, workspace.id, parent, validateActor)
  const canonical = canonicalDirectory(selected)
  const directories = attach(workspaceSlug, canonical)
  return { status: 'authorized', path: canonical, directories }
}

/** 拖拽/上下文菜单的既有路径入口也必须有main原生确认，不能仅信renderer提交的路径。 */
export async function confirmWorkspaceDirectoryAttachment(
  workspaceSlug: string,
  directoryPath: string,
  parent: BrowserWindow | null,
  attach: (workspaceSlug: string, directoryPath: string) => string[],
  validateActor: () => void = () => {},
): Promise<KnowledgeDirectoryGrantResult> {
  const workspace = getKnownKnowledgeWorkspace(workspaceSlug)
  assertGrantContext(workspaceSlug, workspace.id, parent, validateActor)
  if (typeof directoryPath !== 'string' || !isAbsolute(directoryPath) || directoryPath.includes('\u0000') || directoryPath.length > 32768) {
    throw new Error('附加目录路径必须是有效绝对路径')
  }
  const options: Electron.MessageBoxOptions = {
    type: 'question', title: '授权工作区附加目录',
    message: `允许工作区「${workspace.name}」访问以下目录？`,
    detail: `${directoryPath}\n\n该目录将对本工作区的Agent和记忆外置链接开放。撤销授权不会删除文件，也不会批准维护AGENTS.md。`,
    buttons: ['取消', '授权访问'], defaultId: 0, cancelId: 0, noLink: true,
  }
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  if (result.response !== 1) return { status: 'cancelled' }
  assertGrantContext(workspaceSlug, workspace.id, parent, validateActor)
  const canonical = canonicalDirectory(directoryPath)
  return { status: 'authorized', path: canonical, directories: attach(workspaceSlug, canonical) }
}

/** 撤销只移除授权记录；不删除磁盘文件，也不改动既有链接。 */
export function revokeWorkspaceKnowledgeDirectory(
  workspaceSlug: string,
  directoryPath: string,
  detach: (workspaceSlug: string, directoryPath: string) => string[],
): string[] {
  getKnownKnowledgeWorkspace(workspaceSlug)
  if (typeof directoryPath !== 'string' || !directoryPath) throw new Error('撤销授权需要目录路径')
  return detach(workspaceSlug, directoryPath)
}
