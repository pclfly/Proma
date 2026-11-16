/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: Agent会话视图
 * - planning: 任务、日程与定时任务统一视图
 * - agent-skills: Agent 技能（Skills/MCP）全屏管理视图
 * - vault: 无Agent宿主时独立显示的Obsidian Vault视图
 * - starred: 收藏会话独立视图
 */

import { atom } from 'jotai'

export type ActiveView = 'conversations' | 'planning' | 'agent-skills' | 'vault' | 'starred'
export type AgentSkillsCapabilityTab = 'skills' | 'mcp' | 'memory'

/** 当前活跃视图（不持久化，每次启动默认显示对话） */
export const activeViewAtom = atom<ActiveView>('conversations')

/** Agent 技能视图当前子页，用于外部入口直达 MCP 管理 */
export const agentSkillsTabAtom = atom<AgentSkillsCapabilityTab>('skills')
/** 外部入口要求技能中心打开指定 Skill 详情。 */
export const pendingAgentSkillSlugAtom = atom<string | null>(null)

/** Skills/MCP 分区侧栏的计数，由主视图加载完成后回填。 */
export interface AgentSkillsSectionCounts {
  skills: number
  mcp: number
  memory: number
}
export const agentSkillsSectionCountsAtom = atom<AgentSkillsSectionCounts>({
  skills: 0,
  mcp: 0,
  memory: 0,
})
