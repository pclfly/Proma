/**
 * Pi 助手流式 block 序列化。
 *
 * 官方 0.22.0 的 `assistant_blocks` 协议：把累计的 message_update 折叠成
 * reset / block_start / block 事件，渲染层只消费每个 block 的最新快照。
 * 本地当前使用增量 `sdk_delta`，此模块保留官方 block 兼容投影，供需要快照的
 * 持久化/测试路径复用，避免重新推导 thinking/tool_use 形状。
 */

import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { displayToolName } from './pi-message-adapter'
import {
  getPiAssistantTextPhase,
  type PiAssistantTextPhase,
} from './pi-text-phase'

export type { PiAssistantTextPhase }
export { getPiAssistantTextPhase }

export type PiAssistantBlock =
  | { type: 'text'; text: string; phase?: PiAssistantTextPhase }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type PiAssistantBlockEvent =
  | { type: 'reset' }
  | { type: 'block_start'; contentIndex: number; block: PiAssistantBlock }
  | { type: 'block'; contentIndex: number; block: PiAssistantBlock }

/** 把 Pi 的累计 message_update 投影成官方 block 事件；无关事件返回 undefined。 */
export function serializePiAssistantBlock(
  event: AssistantMessageEvent,
): PiAssistantBlockEvent | undefined {
  switch (event.type) {
    case 'start':
      return { type: 'reset' }
    case 'text_end': {
      const block = event.partial.content[event.contentIndex]
      const phase = getPiAssistantTextPhase(
        event.partial.api,
        block?.type === 'text' ? block.textSignature : undefined,
      )
      return {
        type: 'block',
        contentIndex: event.contentIndex,
        block: { type: 'text', text: event.content, ...(phase ? { phase } : {}) },
      }
    }
    case 'thinking_start':
      return {
        type: 'block_start',
        contentIndex: event.contentIndex,
        block: { type: 'thinking', thinking: '' },
      }
    case 'thinking_delta': {
      const block = event.partial.content[event.contentIndex]
      const thinking = block?.type === 'thinking' ? block.thinking : undefined
      if (thinking === undefined || thinking === '') return undefined
      return {
        type: 'block',
        contentIndex: event.contentIndex,
        block: { type: 'thinking', thinking },
      }
    }
    case 'thinking_end':
      return {
        type: 'block',
        contentIndex: event.contentIndex,
        block: { type: 'thinking', thinking: event.content },
      }
    case 'toolcall_start': {
      const block = event.partial.content[event.contentIndex]
      if (!block || block.type !== 'toolCall') return undefined
      return {
        type: 'block_start',
        contentIndex: event.contentIndex,
        block: {
          type: 'tool_use',
          id: block.id,
          name: displayToolName(block.name, block.arguments as Record<string, unknown>),
          input: {},
        },
      }
    }
    case 'toolcall_end':
      return {
        type: 'block',
        contentIndex: event.contentIndex,
        block: {
          type: 'tool_use',
          id: event.toolCall.id,
          name: displayToolName(
            event.toolCall.name,
            event.toolCall.arguments as Record<string, unknown>,
          ),
          input: event.toolCall.arguments as Record<string, unknown>,
        },
      }
    default:
      return undefined
  }
}
