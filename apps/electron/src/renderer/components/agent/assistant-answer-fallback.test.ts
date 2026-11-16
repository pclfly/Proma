import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKResultMessage } from '@proma/shared'
import { getAssistantAnswerFallback } from './assistant-answer-fallback'

function assistant(): SDKAssistantMessage {
  return { type: 'assistant', parent_tool_use_id: null, uuid: 'final', message: { stop_reason: 'stop', content: [{ type: 'thinking', thinking: '最终思考内容' }] } }
}
function success(): SDKResultMessage {
  return { type: 'result', subtype: 'success', terminal_reason: 'completed', usage: { input_tokens: 0, output_tokens: 0 } }
}

describe('仅思考输出的展示兜底', () => {
  test('Given 成功主线最终消息只有thinking When 展示 Then 派生正文且原消息不变', () => {
    const final = assistant()
    const original = structuredClone(final)
    expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, success()] })).toBe('最终思考内容')
    expect(final).toEqual(original)
  })
  test.each(['error', 'aborted', 'length', 'toolUse', undefined])('Given 终态%s When 展示 Then 不把过程提升为正文', (reason) => {
    const final = assistant(); final.message.stop_reason = reason
    expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, success()] })).toBeUndefined()
  })
  test('Given 流式或用户停止 When 展示 Then 不触发兜底', () => {
    const final = assistant()
    for (const state of [{ isStreaming: true }, { stoppedByUser: true }]) {
      expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, success()], ...state })).toBeUndefined()
    }
  })
  test('Given 有真实text或未执行的tool_use When 展示 Then 不重复正文或提升中间思考', () => {
    for (const block of [{ type: 'text', text: '真实答案' }, { type: 'tool_use', id: 'pending', name: 'Bash', input: {} }]) {
      const final = assistant(); final.message.content.push(block)
      expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, success()] })).toBeUndefined()
    }
  })
  test('Given 缺少成功result或失败结果 When 展示 Then 不猜测完成', () => {
    const final = assistant()
    expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final] })).toBeUndefined()
    expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [success(), final] })).toBeUndefined()
    for (const result of [{ ...success(), subtype: 'error' }, { ...success(), terminal_reason: 'max_tokens' }, { ...success(), errors: ['failure'] }]) {
      expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, result] })).toBeUndefined()
    }
  })
  test('Given 早期思考与子代理内容 When 主线成功结束 Then 只展示最终主线思考', () => {
    const earlier = assistant(); earlier.message.content = [{ type: 'thinking', thinking: '早期过程' }]
    const child = assistant(); child.parent_tool_use_id = 'child-tool'; child.message.content = [{ type: 'thinking', thinking: '子代理内容' }]
    const final = assistant()
    expect(getAssistantAnswerFallback({ assistantMessages: [earlier, final, child], turnMessages: [earlier, final, child, success()] })).toBe('最终思考内容')
    expect(getAssistantAnswerFallback({ assistantMessages: [child], turnMessages: [child, success()] })).toBeUndefined()
  })
  test('Given 文本中的think标签 When 成功但没有正文 Then 使用同一归一规则', () => {
    const final = assistant(); final.message.content = [{ type: 'text', text: '<think>兼容内容</think>' }]
    expect(getAssistantAnswerFallback({ assistantMessages: [final], turnMessages: [final, success()] })).toBe('兼容内容')
  })
})
