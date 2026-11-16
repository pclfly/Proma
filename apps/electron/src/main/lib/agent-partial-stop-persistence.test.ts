import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage } from '@proma/shared'
import { absorbPartialAssistantForStop } from './agent-partial-stop-persistence'

function partial(text: string, extra: Record<string, unknown> = {}): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: 'frame-1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  } as unknown as SDKAssistantMessage
}

/** 与 persistSDKMessages 的过滤条件保持一致，用于验证产物会真正落盘。 */
function survivesPersistFilter(message: ReturnType<typeof absorbPartialAssistantForStop>): boolean {
  const record = message as unknown as Record<string, unknown>
  return record._partial !== true
}

describe('停止时保住已生成的最后一段回复（0.21.92 Bug 修复）', () => {
  test('Given 用户停止且存在预览帧 When 收尾 Then 产出可落盘的正式 assistant 消息', () => {
    const absorbed = absorbPartialAssistantForStop(partial('已经写了一半的答案'), true)
    expect(absorbed).toBeDefined()
    expect(absorbed!.type).toBe('assistant')
    expect(survivesPersistFilter(absorbed)).toBe(true)
    const content = (absorbed as SDKAssistantMessage).message.content
    expect(content).toEqual([{ type: 'text', text: '已经写了一半的答案' }])
  })

  test('Given 未停止（自然结束）When 收尾 Then 不补任何消息', () => {
    // 自然结束时正式 assistant 消息已在 result 前入队，重复补会写出两份。
    expect(absorbPartialAssistantForStop(partial('完整答案'), false)).toBeUndefined()
  })

  test('Given 预览帧只有空白 When 停止 Then 不写出空消息', () => {
    expect(absorbPartialAssistantForStop(partial('   \n  '), true)).toBeUndefined()
  })

  test('Given 没有预览帧 When 停止 Then 保持 undefined 而不抛错', () => {
    expect(absorbPartialAssistantForStop(undefined, true)).toBeUndefined()
  })

  test('Given 预览帧带传输层错误 When 停止 Then 去掉 error 只保留已生成正文', () => {
    // 停止/失败常伴随 error 字段；落盘内容应是纯正文，错误由单独的 TypedError 消息表达。
    const withError = partial('部分内容', { error: { message: 'stream aborted', errorType: 'aborted' } })
    const absorbed = absorbPartialAssistantForStop(withError, true) as SDKAssistantMessage
    expect((absorbed as unknown as Record<string, unknown>).error).toBeUndefined()
    expect(absorbed.message.content).toEqual([{ type: 'text', text: '部分内容' }])
  })

  test('Given 预览帧同时含文本与工具调用 When 停止 Then 保留全部内容块', () => {
    const mixed = {
      type: 'assistant',
      uuid: 'frame-2',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: '先说一句' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
        ],
      },
    } as unknown as SDKAssistantMessage
    const absorbed = absorbPartialAssistantForStop(mixed, true) as SDKAssistantMessage
    expect(absorbed.message.content).toHaveLength(2)
  })
})
