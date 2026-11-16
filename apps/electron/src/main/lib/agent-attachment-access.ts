/**
 * Agent 工作台附件的安全路径校验与读取。
 *
 * 官方 0.22.0：附件路径必须位于 `{configDir}/agent-workspaces/{workspaceSlug}/{sessionId}/...`，
 * 会话/工作区归属必须一致；路径逐级拒绝符号链接、非普通文件和多硬链接文件。
 */

import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/

export interface AgentAttachmentAccessDeps {
  configDir: string | (() => string)
  getAgentSession: (sessionId: string) => { id: string; workspaceId?: string } | undefined
  isAgentSessionDeleting: (sessionId: string) => boolean
  getWorkspace: (workspaceId: string) => { id: string; slug: string } | undefined
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 校验 root 到 target 的每一级都不含符号链接，文件必须是单硬链接普通文件。 */
export function assertManagedFile(root: string, target: string): void {
  if (!isWithin(root, target)) throw new Error('路径超出受管目录')
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('受管目录不安全')
  const canonicalRoot = realpathSync(root)
  const parts = relative(root, target).split(sep)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] ?? '')
    const entry = lstatSync(current)
    const isFile = index === parts.length - 1
    if (entry.isSymbolicLink() || (isFile ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) {
      throw new Error('路径包含链接或非普通文件')
    }
    if (!isWithin(canonicalRoot, realpathSync(current))) throw new Error('路径真实目标超出受管目录')
  }
}

/** 打开普通文件并核对 fd 与路径身份，拒绝打开期间被替换。 */
export function openVerifiedAgentFile(filePath: string): number {
  const before = lstatSync(filePath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('文件包含不安全的链接或类型')
  }
  const fd = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const after = fstatSync(fd)
    const current = lstatSync(filePath)
    if (
      !after.isFile()
      || after.nlink !== 1
      || current.isSymbolicLink()
      || current.dev !== after.dev
      || current.ino !== after.ino
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new Error('文件在打开时改变')
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function readVerifiedAgentFile(filePath: string, verify: () => void): Buffer {
  const fd = openVerifiedAgentFile(filePath)
  try {
    verify()
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function createAgentAttachmentAccess(deps: AgentAttachmentAccessDeps) {
  const resolveAgentAttachmentPath = (localPath: string): string => {
    if (
      typeof localPath !== 'string'
      || !isAbsolute(localPath)
      || localPath.includes('\0')
      || (sep === '/' && localPath.includes('\\'))
      || localPath.split(/[\\/]/).some((part) => part === '..' || part === '.')
    ) {
      throw new Error('Agent 附件必须使用安全的工作台绝对路径')
    }

    const root = resolve(typeof deps.configDir === 'function' ? deps.configDir() : deps.configDir)
    const path = resolve(localPath)
    if (!isWithin(root, path)) throw new Error('Agent 附件超出配置目录')

    const parts = relative(root, path).split(sep)
    if (parts.length < 4 || parts[0] !== 'agent-workspaces') {
      throw new Error('绝对附件不在 Agent 工作台中')
    }
    const sessionId = parts[2]
    if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('Agent 会话 ID 无效')

    const session = deps.getAgentSession(sessionId)
    if (!session || session.id !== sessionId || deps.isAgentSessionDeleting(sessionId)) {
      throw new Error('需要一个存在且未删除中的 Agent 会话')
    }
    const workspace = session.workspaceId ? deps.getWorkspace(session.workspaceId) : undefined
    if (!workspace || workspace.id !== session.workspaceId || !SAFE_ID.test(workspace.slug) || parts[1] !== workspace.slug) {
      throw new Error('Agent 附件工作台归属无效')
    }

    assertManagedFile(root, path)
    return path
  }

  return { resolveAgentAttachmentPath }
}
