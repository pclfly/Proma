/**
 * ArmorRefusalBadge — Agent「破甲」实时拒答检测状态条（诊断用）。
 *
 * 位置：输入框上方常驻状态行（对应 gen-3 的 conversation.input.dock）。
 * 行为：
 * - 仅在本会话开启破甲（sessionMeta.armorEnabled）时显示；
 * - 会话流式进行中显示「思考中…」（绿色呼吸）；
 * - 最近一条助手消息开头窗口命中拒绝话术 → 红色「✗ 拒绝: <短语>」；
 * - 命中改口 / 安全替代话术 → 黄色「⚠ 改口: <短语>」；
 * - 其余 → 绿色「✓ 破甲生效」，并显示 gen-3 评分器判定的命中域与载荷数。
 *
 * 注意：本组件只读不改——它只把模型输出里的拒答话术可视化出来，
 * 不重新注入提示词、不改变模型行为。
 * enabled 状态由会话元数据派生（与 PersonalDirectiveToggle 同源）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  agentSDKMessagesCacheAtom,
  agentSessionStreamingStateAtomFamily,
  sessionArmorEnabledAtom,
} from '@/atoms/agent-atoms'
import { scoreResponse, lastAssistantText, type ArmorDomain } from '@/lib/armor-score'

/** ArmorRefusalBadge 属性接口 */
interface ArmorRefusalBadgeProps {
  sessionId: string
}

const PILL_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '3px 10px',
  borderRadius: '6px',
  border: '1px solid rgba(34, 197, 94, 0.4)',
  background: 'rgba(34, 197, 94, 0.1)',
  color: '#22c55e',
  fontSize: '11px',
  lineHeight: '16px',
  fontFamily: 'inherit',
  userSelect: 'none',
  whiteSpace: 'nowrap',
}

const STYLES = {
  pass: {
    border: '1px solid rgba(34, 197, 94, 0.4)',
    background: 'rgba(34, 197, 94, 0.1)',
    color: '#22c55e',
  },
  running: {
    border: '1px solid rgba(34, 197, 94, 0.4)',
    background: 'rgba(34, 197, 94, 0.1)',
    color: '#22c55e',
  },
  refusal: {
    border: '1px solid rgba(239, 68, 68, 0.5)',
    background: 'rgba(239, 68, 68, 0.12)',
    color: '#ef4444',
  },
  fallback: {
    border: '1px solid rgba(234, 179, 8, 0.5)',
    background: 'rgba(234, 179, 8, 0.12)',
    color: '#eab308',
  },
} as const

export function ArmorRefusalBadge({ sessionId }: ArmorRefusalBadgeProps): React.ReactElement | null {
  // 破甲是会话级：直接订阅该会话的开关，切换后即时跟随。
  // 不再从全局 settings 回填 —— 那会让徽标在没开破甲的会话里也显示。
  const enabled = useAtomValue(sessionArmorEnabledAtom(sessionId))
  const streamingState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const messagesCache = useAtomValue(agentSDKMessagesCacheAtom)

  if (!enabled) return null

  const running = streamingState?.running ?? false
  const messages = messagesCache.get(sessionId)
  const score = scoreResponse(lastAssistantText(messages))

  const DOMAIN_LABEL: Record<ArmorDomain, string> = {
    web: '渗透', game: '游戏逆向', llm: 'LLM 逆向', mobile: '移动端',
    miniprogram: '小程序', network: '内网', cloud: '云', crack: '破解', nsfw: '虚构',
  }
  const domainTag = score.domain && score.domainHits > 0
    ? ` · ${DOMAIN_LABEL[score.domain]}×${score.domainHits}`
    : ''

  let label: string
  let style: React.CSSProperties
  let title: string

  if (running) {
    label = '思考中…'
    style = { ...PILL_BASE, ...STYLES.running }
    title = '破甲已开启 · 模型正在生成'
  } else if (score.verdict === 'refusal') {
    const word = score.refusal[0] ?? '拒绝话术'
    label = `✗ 拒绝: ${word}`
    style = { ...PILL_BASE, ...STYLES.refusal }
    title = `开头窗口检测到拒绝话术：${score.refusal.join('、') || word}（仅诊断显示，未修改模型行为）`
  } else if (score.verdict === 'fallback') {
    const word = score.fallback[0] ?? '改口话术'
    label = `⚠ 改口: ${word}`
    style = { ...PILL_BASE, ...STYLES.fallback }
    title = `检测到改口 / 安全替代话术：${score.fallback.join('、') || word}`
  } else {
    label = `✓ 破甲生效${domainTag}`
    style = { ...PILL_BASE, ...STYLES.pass }
    title = `破甲已开启 · 开头窗口未命中拒绝 / 改口话术；防御侧短语 ${score.safe.length} 类，载荷侧短语 ${score.risk.length} 类`
  }

  return (
    <div className="flex items-center px-2 py-1">
      <span
        style={style}
        className={running ? 'animate-pulse' : undefined}
        title={title}
        data-armor-badge={score.verdict}
      >
        {label}
      </span>
    </div>
  )
}
