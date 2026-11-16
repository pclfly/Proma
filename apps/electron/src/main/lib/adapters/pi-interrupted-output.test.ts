import { describe, expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import {
  INTERRUPTED_OUTPUT_MESSAGE_TYPE,
  attachInterruptedOutputNotes,
  buildFailedOutputNote,
  buildInterruptedOutputNote,
} from './pi-interrupted-output'

function assistant(stopReason: string, text: string, errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  } as unknown as AssistantMessage
}

function setup() {
  let listener: ((event: AgentSessionEvent) => void) | undefined
  const notes: string[] = []
  const detach = attachInterruptedOutputNotes({
    sendCustomMessage: async (message) => {
      notes.push(message.content)
      return undefined
    },
    subscribe: (next) => {
      listener = next
      return () => { listener = undefined }
    },
  })
  return { notes, emit: (event: AgentSessionEvent) => listener?.(event), detach }
}

describe('中断/失败输出回填', () => {
  test('Given 用户中断且有已展示文本 When 生成 Then 包裹 interrupted 输出', () => {
    const note = buildInterruptedOutputNote(assistant('aborted', 'partial answer'))
    expect(note).toContain('用户中断了你的上一条回复')
    expect(note).toContain('<interrupted_assistant_output>')
    expect(note).toContain('partial answer')
  })

  test('Given 超长文本 When 生成 Then 保留头和尾并标注省略字数', () => {
    const text = `HEAD-${'x'.repeat(30_000)}-TAIL`
    const note = buildInterruptedOutputNote(assistant('aborted', text))!
    expect(note).toContain('HEAD-')
    expect(note).toContain('-TAIL')
    expect(note).toMatch(/中间 \d+ 字已省略/)
  })

  test('Given 错误终止 When 生成 Then 包含错误原因且只处理 error', () => {
    const note = buildFailedOutputNote(assistant('error', 'shown', 'upstream 500\nbad gateway'))
    expect(note).toContain('upstream 500 bad gateway')
    expect(buildFailedOutputNote(assistant('aborted', 'shown'))).toBeUndefined()
  })

  test('Given 没有文本或非 assistant When 生成 Then 返回 undefined', () => {
    expect(buildInterruptedOutputNote(assistant('aborted', '   '))).toBeUndefined()
    expect(buildInterruptedOutputNote({ role: 'user' } as unknown as AssistantMessage)).toBeUndefined()
  })

  test('Given 中断事件 When 订阅 Then 立即发送隐藏消息；失败延迟到 settle', () => {
    const { notes, emit } = setup()
    emit({ type: 'message_end', message: assistant('aborted', 'partial') } as unknown as AgentSessionEvent)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('partial')

    emit({ type: 'message_end', message: assistant('error', 'failed text', 'boom') } as unknown as AgentSessionEvent)
    expect(notes).toHaveLength(1)
    emit({ type: 'agent_settled', aborted: false } as unknown as AgentSessionEvent)
    expect(notes).toHaveLength(2)
    expect(notes[1]).toContain('boom')
    expect(notes[1]).toContain('failed text')

    emit({ type: 'message_end', message: assistant('error', 'ignored', 'boom') } as unknown as AgentSessionEvent)
    emit({ type: 'agent_settled', aborted: true } as unknown as AgentSessionEvent)
    expect(notes).toHaveLength(2)
  })

  test('Given 取消订阅 When 事件继续 Then 不再发送', () => {
    const { notes, emit, detach } = setup()
    detach()
    emit({ type: 'message_end', message: assistant('aborted', 'partial') } as unknown as AgentSessionEvent)
    expect(notes).toHaveLength(0)
  })

  test('Given 消息类型常量 When 检查 Then 保持官方名称', () => {
    expect(INTERRUPTED_OUTPUT_MESSAGE_TYPE).toBe('proma-interrupted-output')
  })
})
