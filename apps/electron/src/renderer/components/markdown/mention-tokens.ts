import { createMentionPattern } from '@/lib/mention-patterns'

/**
 * 正文 mention 的文本切分。
 *
 * react-markdown 路径由 remarkMentions 把文本节点换成 mention:// 链接，
 * 自研管线在 text token 上做同样的切分，两条路径共用这里的实现，避免
 * 编码规则（已编码值不重复编码、named reference 带标题）分叉。
 */

export type MentionType = 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'

export interface MentionTextSegment {
  type: 'text'
  value: string
}

export interface MentionLinkSegment {
  type: 'mention'
  /** 供 MarkdownLink 识别的 mention:// URL */
  href: string
  /** 原文片段，作为链接可见文本 */
  text: string
}

export type MentionSegment = MentionTextSegment | MentionLinkSegment

/** 解码失败时保留原始值，展示层不能因为坏编码整段消失。 */
export function safeDecodeMention(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 按 mention 语法切分纯文本；不含 mention 时返回单个文本片段。 */
export function splitMentionText(text: string): MentionSegment[] {
  if (!text) return []

  // 每次调用创建独立正则实例，避免 /g 状态在并发解析间互相干扰。
  const mentionPattern = createMentionPattern()
  if (!mentionPattern.test(text)) return [{ type: 'text', value: text }]
  mentionPattern.lastIndex = 0

  const segments: MentionSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = mentionPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    const mentionType: MentionType = match[1]
      ? 'file'
      : match[2]
        ? 'skill'
        : match[3]
          ? 'mcp'
          : match[4]
            ? 'session'
            : match[6]
              ? 'todo'
              : match[8]
                ? 'calendar_event'
                : 'quote'
    const referenceId = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6] ?? match[8] ?? match[10] ?? ''
    const encodedLabel = match[5] ?? match[7] ?? match[9]
    const rawValue = encodedLabel ? `${referenceId}::${safeDecodeMention(encodedLabel)}` : referenceId
    // 文件/Skill/MCP 旧消息可能已经编码；带标题的 named reference 始终重新编码整个值。
    const alreadyEncoded = !encodedLabel && /%[0-9A-Fa-f]{2}/.test(referenceId)
    const safeValue = alreadyEncoded ? referenceId : encodeURIComponent(rawValue)
    segments.push({
      type: 'mention',
      href: `mention://${mentionType}/${safeValue}`,
      text: match[0],
    })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments
}