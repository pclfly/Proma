import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'
import { normalizeThinkTagsInContentBlocks } from '@proma/session-core'

interface AssistantAnswerFallbackInput {
  assistantMessages: SDKAssistantMessage[]
  turnMessages: SDKMessage[]
  isStreaming?: boolean
  stoppedByUser?: boolean
}

/** 只派生 UI 文本；不改 SDK 消息、推理配置或下一轮模型上下文。 */
export function getAssistantAnswerFallback({ assistantMessages, turnMessages, isStreaming, stoppedByUser }: AssistantAnswerFallbackInput): string | undefined {
  if (isStreaming || stoppedByUser) return undefined
  const mainline = assistantMessages.filter((message) => !message.parent_tool_use_id)
  const final = mainline.at(-1)
  if (!final || mainline.some((message) => message.error)) return undefined
  if (final.message.stop_reason !== 'stop' && final.message.stop_reason !== 'end_turn') return undefined

  // stop_reason 不能代表整个工具轮次已成功结算；必须同时有主线 success result。
  const resultIndex = turnMessages.findLastIndex((message) => message.type === 'result'
    && !('parent_tool_use_id' in message && message.parent_tool_use_id))
  const finalIndex = turnMessages.findLastIndex((message) => message === final
    || (message.type === 'assistant' && final.uuid && message.uuid === final.uuid && !message.parent_tool_use_id))
  if (finalIndex < 0 || resultIndex <= finalIndex) return undefined
  const result = turnMessages[resultIndex]
  if (result?.type !== 'result' || result.subtype !== 'success'
    || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0))
    || result.isSyntheticCompactionResult || (result.terminal_reason && result.terminal_reason !== 'completed')
    || ('is_error' in result && result.is_error === true)) return undefined

  const blocks = normalizeThinkTagsInContentBlocks(final.message.content)
  if (blocks.some((block) => block.type === 'thinking'
    ? typeof block.thinking !== 'string'
    : block.type !== 'text' || typeof block.text !== 'string' || block.text.trim().length > 0)) return undefined
  const thinking = blocks
    .flatMap((block) => block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : [])
    .join('\n\n')
    .trim()
  return thinking || undefined
}
