/**
 * 中断/失败回复的可见输出回填。
 *
 * 用户中断或上游错误终止时，模型下一轮需要知道自己上一轮已经展示给用户的内容，
 * 否则容易重复整段回答或丢失未完成结论。这里把已展示的文本作为隐藏
 * custom message 注入会话，不触发新 turn。
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { isAssistantPiMessage } from './pi-message-adapter'

export const INTERRUPTED_OUTPUT_MESSAGE_TYPE = 'proma-interrupted-output'

const INTERRUPTED_OUTPUT_MAX_CHARS = 24_000
const INTERRUPTED_OUTPUT_HEAD_CHARS = 8_000
const FAILED_OUTPUT_ERROR_MAX_CHARS = 160

interface CustomMessageSender {
  sendCustomMessage: (
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ) => Promise<unknown>
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
}

function extractShownOutputText(message: AssistantMessage): string | undefined {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
  if (!text) return undefined
  if (text.length <= INTERRUPTED_OUTPUT_MAX_CHARS) return text
  const tailLength = INTERRUPTED_OUTPUT_MAX_CHARS - INTERRUPTED_OUTPUT_HEAD_CHARS
  return `${text.slice(0, INTERRUPTED_OUTPUT_HEAD_CHARS)}

[……中间 ${text.length - INTERRUPTED_OUTPUT_MAX_CHARS} 字已省略……]

${text.slice(text.length - tailLength)}`
}

function wrapOutputNote(header: string, shown: string): string {
  return [header, '<interrupted_assistant_output>', shown, '</interrupted_assistant_output>'].join('\n')
}

export function buildInterruptedOutputNote(message: AssistantMessage): string | undefined {
  if (!isAssistantPiMessage(message) || message.stopReason !== 'aborted') return undefined
  const shown = extractShownOutputText(message)
  if (!shown) return undefined
  return wrapOutputNote(
    '[Proma] 用户中断了你的上一条回复。以下是中断前你已输出、并已展示给用户的内容（未完成，可能在句中截断）：',
    shown,
  )
}

export function buildFailedOutputNote(message: AssistantMessage): string | undefined {
  if (!isAssistantPiMessage(message) || message.stopReason !== 'error') return undefined
  const shown = extractShownOutputText(message)
  if (!shown) return undefined
  const reason = (message.errorMessage ?? '未知错误').replace(/\s+/g, ' ').trim().slice(0, FAILED_OUTPUT_ERROR_MAX_CHARS)
  return wrapOutputNote(
    `[Proma] 你的上一条回复因错误终止（${reason}）。以下是终止前你已输出、并已展示给用户的内容（不完整，可能在句中截断）：`,
    shown,
  )
}

/** 订阅 session 事件；返回取消订阅函数。 */
export function attachInterruptedOutputNotes(session: CustomMessageSender): () => void {
  let pendingFailedOutputNote: string | undefined

  const sendNote = (note: string): void => {
    void session.sendCustomMessage(
      { customType: INTERRUPTED_OUTPUT_MESSAGE_TYPE, content: note, display: false },
      { triggerTurn: false },
    ).catch(() => {})
  }

  return session.subscribe((event) => {
    switch (event.type) {
      case 'message_end': {
        if (!isAssistantPiMessage(event.message)) break
        if (event.message.stopReason === 'error') {
          pendingFailedOutputNote = buildFailedOutputNote(event.message)
        } else {
          pendingFailedOutputNote = undefined
        }
        const note = buildInterruptedOutputNote(event.message)
        if (note) sendNote(note)
        break
      }
      case 'agent_start':
        pendingFailedOutputNote = undefined
        break
      case 'agent_settled': {
        const note = pendingFailedOutputNote
        pendingFailedOutputNote = undefined
        if (event.aborted || !note) break
        sendNote(note)
        break
      }
    }
  })
}
