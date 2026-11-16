/**
 * 破甲全局配置判定
 *
 * 会话级开关只决定「本会话用不用」，能否真正注入还取决于 settings.json：
 * 全局 `personalDirective.enabled` 必须为 true，且 `content` / `markdownPath`
 * 至少有一个非空。UI 与主进程用同一口径判定，避免出现「开关亮了但什么都没
 * 注入」的假成功。
 */

import type { AgentPersonalDirective } from '@/types/settings'

/** 全局破甲配置的三种状态 */
export type PersonalDirectiveConfigState =
  /** 已启用且存在正文来源，可以开启会话破甲 */
  | 'ready'
  /** 全局 enabled 为 false，注入会被主进程直接跳过 */
  | 'disabled'
  /** 已启用但既没有 content 也没有 markdownPath，无正文可注入 */
  | 'empty'

/** 检查全局破甲配置是否具备可注入的正文来源。 */
export function inspectPersonalDirective(
  personalDirective: AgentPersonalDirective | undefined,
): PersonalDirectiveConfigState {
  if (!personalDirective?.enabled) return 'disabled'

  const hasContent = (personalDirective.content ?? '').trim().length > 0
  const hasMarkdownPath = (personalDirective.markdownPath ?? '').trim().length > 0
  return hasContent || hasMarkdownPath ? 'ready' : 'empty'
}
