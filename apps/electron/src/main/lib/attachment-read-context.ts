/**
 * Agent 附件读取上下文校验。
 *
 * 官方 0.22.0：只有当前 Agent 会话自己工作台目录下的附件才允许通过
 * `resolvePath` 解析；其他路径（包括同一工作区下别的会话）一律拒绝。
 */

import { isAbsolute, join, relative, sep } from 'node:path'

export interface AttachmentReadContext {
  kind: 'agent'
  sessionId: string
}

export interface AttachmentContextResolverDeps {
  resolvePath: (localPath: string) => string
  configDir: () => string
}

export function createAttachmentContextResolver(deps: AttachmentContextResolverDeps) {
  return (localPath: string, context: AttachmentReadContext | undefined): string => {
    if (
      !context
      || typeof context !== 'object'
      || context.kind !== 'agent'
      || typeof context.sessionId !== 'string'
      || !context.sessionId
      || typeof localPath !== 'string'
      || !isAbsolute(localPath)
    ) {
      throw new Error('附件读取需要有效 Agent 会话及工作台绝对路径')
    }
    const path = deps.resolvePath(localPath)
    const parts = relative(join(deps.configDir(), 'agent-workspaces'), path).split(sep)
    if (parts.length < 3 || parts[1] !== context.sessionId) {
      throw new Error('附件不属于当前 Agent 会话')
    }
    return path
  }
}
