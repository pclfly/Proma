import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import type { MessageGroup } from './SDKMessageRenderer'
import { areMessageGroupRendererPropsEqual } from './SDKMessageRenderer'

function createUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage
}

function createAssistantMessage(text: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKAssistantMessage
}

describe('Agent 历史消息渲染缓存', () => {
  test('Given turn 分组对象被重建但底层消息未变 When 比较渲染属性 Then 复用已有渲染结果', () => {
    const assistant = createAssistantMessage('已完成')
    const previousGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
    }
    const nextGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
    }

    expect(areMessageGroupRendererPropsEqual(
      { group: previousGroup },
      { group: nextGroup },
    )).toBe(true)
  })

  test('Given 当前 turn 收到新消息 When 比较渲染属性 Then 触发重新渲染', () => {
    const first = createAssistantMessage('处理中')
    const second = createAssistantMessage('已完成')
    const previousMessages: SDKMessage[] = [first]
    const nextMessages: SDKMessage[] = [first, second]
    const previousGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [first],
      turnMessages: previousMessages,
    }
    const nextGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [first, second],
      turnMessages: nextMessages,
    }

    expect(areMessageGroupRendererPropsEqual(
      { group: previousGroup },
      { group: nextGroup },
    )).toBe(false)
  })

  test('Given 当前 turn 仅追加工具结果 When 比较渲染属性 Then 触发工具结果渲染', () => {
    const assistant = createAssistantMessage('正在读取文件')
    const toolResult = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'TOOL_ID', content: '文件内容' }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage
    const previousGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
    }
    const nextGroup: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, toolResult],
    }

    expect(areMessageGroupRendererPropsEqual(
      { group: previousGroup },
      { group: nextGroup },
    )).toBe(false)
  })

  test('Given 历史用户消息引用保持稳定 When 追加其他消息 Then 用户消息保持缓存', () => {
    const user = createUserMessage('继续任务')
    const previousGroup: MessageGroup = { type: 'user', message: user }
    const nextGroup: MessageGroup = { type: 'user', message: user }

    expect(areMessageGroupRendererPropsEqual(
      { group: previousGroup },
      { group: nextGroup },
    )).toBe(true)
  })
})
