/**
 * 项目归档的展示层逻辑。
 *
 * 归档只影响侧边栏的项目分组可见性：
 * - 不删除会话、不移动项目目录、不改技能与项目配置
 * - 恢复就是清掉标记，所有会话立刻重新出现
 *
 * 用纯函数表达，便于验证"归档不会顺手把东西删掉"这一边界。
 */

import type { AgentWorkspace } from '@proma/shared'

/** 活跃视图只显示未归档项目。 */
export function selectVisibleWorkspaces(
  workspaces: readonly AgentWorkspace[],
  includeArchived: boolean,
): AgentWorkspace[] {
  return includeArchived ? [...workspaces] : workspaces.filter((workspace) => workspace.archived !== true)
}

/** 归档/恢复时提交给 updateAgentWorkspace 的增量，避免误改名称。 */
export function buildArchiveUpdate(archived: boolean): { archived?: boolean } {
  // 恢复时写 undefined 而不是 false，保持索引文件里不残留无用字段。
  return archived ? { archived: true } : { archived: undefined }
}

/** 是否可以从归档区恢复到活跃列表（只有真的归档过才需要恢复入口）。 */
export function canRestoreWorkspace(workspace: AgentWorkspace): boolean {
  return workspace.archived === true
}
