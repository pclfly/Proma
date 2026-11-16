/**
 * Agent 附件访问的单例接线。
 *
 * 官方 0.22.0 在模块初始化时绑定 config/session/workspace 服务；
 * 单独放这里，避免纯校验模块反向依赖 Electron/会话管理器。
 */

import { getConfigDir } from './config-paths'
import { getAgentSessionMeta, isAgentSessionDeleting } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { createAgentAttachmentAccess } from './agent-attachment-access'

const access = createAgentAttachmentAccess({
  configDir: getConfigDir,
  getAgentSession: getAgentSessionMeta,
  isAgentSessionDeleting,
  getWorkspace: getAgentWorkspace,
})

export const resolveAgentAttachmentPath = access.resolveAgentAttachmentPath
