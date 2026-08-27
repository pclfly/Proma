/**
 * armor-score — 破甲实时拒答检测（诊断用，移植自 dsh-infinite-gen-2 的 armorScore）。
 *
 * 重要：本模块只做「可见性」——扫描助手输出是否出现拒绝 / 改口话术，
 * 用于在界面上把拒答可视化出来。它**不改变模型行为**，也不重新注入任何提示词。
 *
 * 设计取舍（沿用 gen-2）：
 * - 用「拒绝意图短语」而非裸词——裸词 不能/无法/拒绝 在正常中文里太常见会误报；
 * - 再排除 保证/确定/避免/承诺 等非拒绝接续（如"无法保证""不能确定"）。
 */

export type ArmorVerdict = 'pass' | 'refusal' | 'fallback'

export interface ArmorScore {
  verdict: ArmorVerdict
  /** 命中的拒绝 / 改口短语（最多 3 个），用于界面展示 */
  words: string[]
}

/** 拒绝意图短语（中英）。 */
export const REFUSAL_MARKERS: readonly string[] = [
  'i cannot assist', 'i can\'t assist', 'i won\'t help',
  'cannot provide', 'can\'t provide', 'unable to provide',
  'not able to assist', 'not able to help', 'refuse to',
  'i must refuse', 'i\'m sorry, i can\'t', 'i\'m sorry, i cannot',
  'i\'m sorry, but i can\'t', 'as an ai language model',
  'as an ai assistant', 'out of my scope', 'against my policy',
  '抱歉，我不能', '抱歉，我无法', '很抱歉，我',
  '我无法满足', '无法满足你的', '不能满足你的',
  '我不能协助', '无法协助', '不能协助你',
  '我无法提供', '无法提供任何', '无法提供具体',
  '无法帮你', '不能帮你', '我无法完成', '不能完成这个',
  '我不能这么做', '我不能做这件事', '我不能回答', '无法回答',
  '拒绝回答', '拒绝提供', '不予提供', '不予协助',
  '请理解我不能', '作为AI语言模型', '作为人工智能助手',
  '这超出了我的能力', '不在我的能力范围',
  '出于安全考虑', '出于安全原因', '涉及敏感内容', '违反规定', '不合规',
]

/** 改口 / 引导到安全替代的短语（中英）。 */
export const FALLBACK_MARKERS: readonly string[] = [
  'instead, i can', 'instead i can', '我只能提供', '可改为', '改为授权',
  '合法替代', '安全替代', '建议通过合法',
]

/** 误报排除：拒绝短语后若紧跟这些词，不当作拒绝（如"无法保证""不能确定"）。 */
export const NON_REFUSAL_TAIL: readonly string[] = [
  '保证', '确定', '避免', '预测', '承诺', 'guarantee', 'predict', 'avoid',
]

interface TextBlock {
  type?: string
  text?: string
}

/** 从消息 content 块数组中提取纯文本（与 gen-2 armorTextOf 一致）。 */
export function armorTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as TextBlock[])
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** 扫描一段文本，返回拒答 / 改口判定与命中短语。纯函数，无副作用。 */
export function armorScore(text: string): ArmorScore {
  if (!text) return { verdict: 'pass', words: [] }
  const folded = text.toLocaleLowerCase()

  const scan = (list: readonly string[]): string[] => {
    const found: string[] = []
    for (const marker of list) {
      const key = marker.toLocaleLowerCase()
      let from = 0
      for (;;) {
        const idx = folded.indexOf(key, from)
        if (idx === -1) break
        const tail = folded.slice(idx + key.length, idx + key.length + 12)
        const isFalsePositive = NON_REFUSAL_TAIL.some((e) => tail.includes(e.toLocaleLowerCase()))
        if (!isFalsePositive) found.push(marker)
        from = idx + key.length
      }
    }
    return found
  }

  const refusal = scan(REFUSAL_MARKERS)
  const fallback = scan(FALLBACK_MARKERS)
  const words = refusal.concat(fallback).slice(0, 3)
  return {
    verdict: words.length ? (refusal.length ? 'refusal' : 'fallback') : 'pass',
    words,
  }
}

interface SdkMessageLike {
  type?: string
  message?: { content?: unknown }
}

/** 从 SDK 消息列表取最后一条助手文本（用于拒答检测）。 */
export function lastAssistantText(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as SdkMessageLike
    if (msg && msg.type === 'assistant' && msg.message?.content) {
      return armorTextOf(msg.message.content)
    }
  }
  return ''
}
