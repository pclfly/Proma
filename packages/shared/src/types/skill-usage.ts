/**
 * Skills 真实使用统计的跨进程契约。
 *
 * 统计口径由主进程按会话激活记录计算；renderer 只消费结果，不自行猜测
 * “未使用”，也不把正文里提到 Skill 名称当作激活。
 */

export interface SkillUsageStatView {
  /** 最近一次真实激活时间 */
  lastUsedAt: number
  /** 统计窗口内的激活次数 */
  useCount: number
  /** 发生过激活的会话数 */
  sessionsUsed: number
}

export interface SkillUsageCoverageView {
  scannedSessions: number
  totalWorkspaceSessions: number
  truncated: boolean
  earliestActivityAt: number
  earliestUsedAt: number
  unreadableSessions: number
  computedAt: number
}

export interface StaleSkillView {
  slug: string
  name: string
  lastUsedAt?: number
  useCount: number
  sessionsUsed: number
  reason: 'outside-window' | 'no-recorded-use'
}

export interface WorkspaceSkillUsageResult {
  /** key 为 `<slug>/SKILL.md` 或规范化路径 */
  usage: Record<string, SkillUsageStatView>
  coverage: SkillUsageCoverageView
  staleSkills: StaleSkillView[]
  /** 覆盖范围内有历史时才允许断言“30 天未用” */
  canAssertUnused: boolean
  days: number
}

export const SKILL_USAGE_IPC_CHANNELS = {
  GET: 'agent:get-skill-usage',
} as const
