import { describe, expect, test } from 'bun:test'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import {
  getPiAssistantTextPhase,
  serializePiAssistantBlock,
} from './pi-assistant-block'

function textMessage(signature?: string) {
  return {
    role: 'assistant',
    api: 'openai-responses',
    content: [{ type: 'text', text: 'answer', textSignature: signature }],
  }
}

describe('Pi assistant block 序列化', () => {
  test('Given start When 序列化 Then reset', () => {
    expect(serializePiAssistantBlock({ type: 'start' } as AssistantMessageEvent))
      .toEqual({ type: 'reset' })
  })

  test('Given text_end When 含 commentary phase Then 返回带 phase 的 text block', () => {
    const signature = JSON.stringify({ v: 1, id: 'msg', phase: 'commentary' })
    const event = {
      type: 'text_end',
      contentIndex: 0,
      content: '先说明',
      partial: textMessage(signature),
    } as unknown as AssistantMessageEvent
    expect(serializePiAssistantBlock(event)).toEqual({
      type: 'block',
      contentIndex: 0,
      block: { type: 'text', text: '先说明', phase: 'commentary' },
    })
    expect(getPiAssistantTextPhase('openai-responses', signature)).toBe('commentary')
  })

  test('Given 非 Responses API 或非法签名 When 读取 phase Then undefined', () => {
    expect(getPiAssistantTextPhase('anthropic-messages', '{"v":1,"id":"x","phase":"final_answer"}'))
      .toBeUndefined()
    expect(getPiAssistantTextPhase('openai-responses', 'not-json')).toBeUndefined()
    expect(getPiAssistantTextPhase('openai-responses', '{"v":2,"id":"x","phase":"commentary"}'))
      .toBeUndefined()
  })

  test('Given thinking 增量 When 空值 Then 跳过，非空返回快照', () => {
    const empty = {
      type: 'thinking_delta',
      contentIndex: 0,
      partial: { content: [{ type: 'thinking', thinking: '' }] },
    } as unknown as AssistantMessageEvent
    expect(serializePiAssistantBlock(empty)).toBeUndefined()
    const value = {
      type: 'thinking_delta',
      contentIndex: 0,
      partial: { content: [{ type: 'thinking', thinking: '思考中' }] },
    } as unknown as AssistantMessageEvent
    expect(serializePiAssistantBlock(value)).toEqual({
      type: 'block',
      contentIndex: 0,
      block: { type: 'thinking', thinking: '思考中' },
    })
  })

  test('Given toolcall start/end Then 输出 display name 与参数', () => {
    const start = {
      type: 'toolcall_start',
      contentIndex: 1,
      partial: {
        content: [
          { type: 'text', text: 'x' },
          { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'a.md' } },
        ],
      },
    } as unknown as AssistantMessageEvent
    expect(serializePiAssistantBlock(start)).toMatchObject({
      type: 'block_start',
      contentIndex: 1,
      block: { type: 'tool_use', id: 'call-1', name: 'Edit', input: {} },
    })
    const end = {
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 'call-1', name: 'edit', arguments: { path: 'a.md' } },
    } as unknown as AssistantMessageEvent
    expect(serializePiAssistantBlock(end)).toMatchObject({
      type: 'block',
      block: { type: 'tool_use', id: 'call-1', name: 'Edit', input: { path: 'a.md' } },
    })
  })
})
