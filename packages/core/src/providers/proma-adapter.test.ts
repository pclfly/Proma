import { describe, expect, test } from 'bun:test'
import type { FileAttachment, ProviderMessage } from '@proma/shared'
import {
  PromaAdapter,
  appendPromaContinuationMessages,
  buildPromaStreamRequest,
  buildPromaTitleRequest,
  parseOpenAICompatSSE,
  parsePromaTitleResponse,
  toPromaMessages,
} from './proma-adapter'
import type { ImageAttachmentData, StreamRequestInput } from './types'
import type { PromaMessage } from './proma-adapter'
import { OpenAIAdapter } from './openai-adapter'

const imageReader = (attachments?: FileAttachment[]): ImageAttachmentData[] => (
  (attachments ?? []).map((attachment) => ({
    mediaType: attachment.mediaType,
    data: `base64-${attachment.id}`,
  }))
)

function attachment(id: string): FileAttachment {
  return {
    id,
    filename: `${id}.png`,
    mediaType: 'image/png',
    localPath: `conv/${id}.png`,
    size: 10,
  }
}

function message(overrides: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    createdAt: 1,
    ...overrides,
  }
}

function input(overrides: Partial<StreamRequestInput> = {}): StreamRequestInput {
  return {
    baseUrl: 'https://api.proma.cool/api/v1',
    apiKey: 'pk_test',
    modelId: 'proma-agent',
    history: [],
    userMessage: 'hi',
    readImageAttachments: imageReader,
    ...overrides,
  }
}

describe('Proma 流式请求构建', () => {
  test('Given baseUrl 带尾斜杠 When 构建 Then 请求 {base}/chat', () => {
    const request = buildPromaStreamRequest(input({ baseUrl: '  https://api.proma.cool/api/v1///  ' }))
    expect(request.url).toBe('https://api.proma.cool/api/v1/chat')
    expect(request.headers).toEqual({
      'Authorization': 'Bearer pk_test',
      'Content-Type': 'application/json',
    })
  })

  test('Given 未指定 thinking When 构建 Then thinkingEnabled 为 false', () => {
    const body = JSON.parse(buildPromaStreamRequest(input()).body) as Record<string, unknown>
    expect(body.model).toBe('proma-agent')
    expect(body.stream).toBe(true)
    expect(body.thinkingEnabled).toBe(false)
    expect(body.tools).toBeUndefined()
  })

  test('Given 开启 thinking 与工具 When 构建 Then body 携带 thinkingEnabled 和 OpenAI 工具格式', () => {
    const body = JSON.parse(buildPromaStreamRequest(input({
      thinkingEnabled: true,
      tools: [{
        name: 'read_file',
        description: '读取文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    })).body) as Record<string, unknown>
    expect(body.thinkingEnabled).toBe(true)
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }])
  })

  test('Given 系统提示与历史 When 转换 Then system 置顶且跳过历史 system', () => {
    const messages = toPromaMessages(input({
      systemMessage: 'sys',
      history: [
        message({ id: 's', role: 'system', content: 'ignored' }),
        message({ id: 'u', role: 'user', content: 'u1' }),
        message({ id: 'a', role: 'assistant', content: 'a1', reasoning: 'think' }),
      ],
      userMessage: 'now',
    }))
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', reasoning_content: 'think' },
      { role: 'user', content: 'now' },
    ])
  })

  test('Given 用户历史带图片 When 转换 Then 图片块在前文本在后', () => {
    const messages = toPromaMessages(input({
      history: [message({ id: 'u1', role: 'user', content: '看图', attachments: [attachment('img')] })],
    }))
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,base64-img' } },
        { type: 'text', text: '看图' },
      ],
    })
  })

  test('Given assistant 历史带图片与推理 When 转换 Then 保留 reasoning_content', () => {
    const messages = toPromaMessages(input({
      history: [message({
        id: 'a1',
        role: 'assistant',
        content: '结果',
        reasoning: '推理',
        attachments: [attachment('out')],
      })],
    }))
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,base64-out' } },
        { type: 'text', text: '结果' },
      ],
      reasoning_content: '推理',
    })
  })

  test('Given 当前消息附件 When 转换 Then 读取为多模态内容', () => {
    const messages = toPromaMessages(input({
      userMessage: '当前',
      attachments: [attachment('cur')],
    }))
    const last = messages[messages.length - 1]
    expect(last).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,base64-cur' } },
        { type: 'text', text: '当前' },
      ],
    })
  })

  test('Given 续接消息 When 构建 Then tool_calls 与 tool 结果按序追加', () => {
    const request = buildPromaStreamRequest(input({
      continuationMessages: [
        {
          role: 'assistant',
          content: '调用工具',
          reasoning: '因为需要文件',
          toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a' } }],
        },
        {
          role: 'tool',
          results: [{ toolCallId: 'tc1', content: '内容' }],
        },
      ],
      thinkingEnabled: true,
    }))
    const body = JSON.parse(request.body) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '调用工具',
      tool_calls: [{
        id: 'tc1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      }],
      reasoning_content: '因为需要文件',
    })
    expect(body.messages[2]).toEqual({
      role: 'tool',
      content: '内容',
      tool_call_id: 'tc1',
    })
  })

  test('Given thinking 关闭 When 追加续接 Then 不携带 reasoning_content', () => {
    const messages: PromaMessage[] = []
    appendPromaContinuationMessages(messages, [{
      role: 'assistant',
      content: '',
      reasoning: '不应出现',
      toolCalls: [{ id: 'tc1', name: 'x', arguments: {} }],
    }], false)
    expect(messages[0]).not.toHaveProperty('reasoning_content')
    expect(messages[0]?.content).toBeNull()
  })

  test('Given 空 apiKey When 构建 Then 仍生成 Bearer 头（由服务端拒绝）', () => {
    const request = buildPromaStreamRequest(input({ apiKey: '' }))
    expect(request.headers.Authorization).toBe('Bearer ')
  })
})

describe('Proma 标题请求构建', () => {
  test('Given 版本化 baseUrl When 构建 Then 回退根域并请求 /v1/chat/completions', () => {
    const request = buildPromaTitleRequest({
      baseUrl: 'https://api.proma.cool/api/v1/',
      apiKey: 'pk',
      modelId: 'm',
      prompt: '你好',
    })
    expect(request.url).toBe('https://api.proma.cool/v1/chat/completions')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    })
  })

  test('Given 两位数版本前缀 When 构建 Then 同样回退', () => {
    const request = buildPromaTitleRequest({
      baseUrl: 'https://gateway.test/api/v10',
      apiKey: 'pk',
      modelId: 'm',
      prompt: 'p',
    })
    expect(request.url).toBe('https://gateway.test/v1/chat/completions')
  })

  test('Given 无版本前缀 When 构建 Then 直接追加 /v1/chat/completions', () => {
    const request = buildPromaTitleRequest({
      baseUrl: 'https://gateway.test',
      apiKey: 'pk',
      modelId: 'm',
      prompt: 'p',
    })
    expect(request.url).toBe('https://gateway.test/v1/chat/completions')
  })

  test('Given 标题响应 When 解析 Then 提取 content；缺失返回 null', () => {
    expect(parsePromaTitleResponse({ choices: [{ message: { content: '标题' } }] })).toBe('标题')
    expect(parsePromaTitleResponse({ choices: [] })).toBeNull()
    expect(parsePromaTitleResponse({})).toBeNull()
  })
})

describe('OpenAI 兼容 SSE 解析（Proma 版本）', () => {
  test('Given content 与 reasoning When 解析 Then 产出 chunk/reasoning', () => {
    const events = parseOpenAICompatSSE(JSON.stringify({
      choices: [{ delta: { content: '你', reasoning_content: '想' } }],
    }))
    expect(events).toEqual([
      { type: 'chunk', delta: '你' },
      { type: 'reasoning', delta: '想' },
    ])
  })

  test('Given 工具调用分片 When 解析 Then start 补默认 id，delta 保持空 id', () => {
    const startEvents = parseOpenAICompatSSE(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read' } }] } }],
    }))
    expect(startEvents).toEqual([{ type: 'tool_call_start', toolCallId: 'tc_0', toolName: 'read' }])

    const deltaEvents = parseOpenAICompatSSE(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }],
    }))
    expect(deltaEvents).toEqual([{ type: 'tool_call_delta', toolCallId: '', argumentsDelta: '{"a":1}' }])
  })

  test('Given finish_reason=tool_calls When 解析 Then done 携带 tool_use', () => {
    const events = parseOpenAICompatSSE(JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    }))
    expect(events).toEqual([{ type: 'done', stopReason: 'tool_use' }])
  })

  test('Given 普通 finish_reason When 解析 Then done 不带 stopReason', () => {
    const events = parseOpenAICompatSSE(JSON.stringify({
      choices: [{ delta: { content: '完' }, finish_reason: 'stop' }],
    }))
    expect(events).toEqual([
      { type: 'chunk', delta: '完' },
      { type: 'done' },
    ])
  })

  test('Given error 字符串/对象/数字 When 解析 Then 统一转 error 事件', () => {
    expect(parseOpenAICompatSSE(JSON.stringify({ error: 'boom' })))
      .toEqual([{ type: 'error', error: 'boom' }])
    expect(parseOpenAICompatSSE(JSON.stringify({ error: { message: '嵌套' } })))
      .toEqual([{ type: 'error', error: '嵌套' }])
    expect(parseOpenAICompatSSE(JSON.stringify({ error: { error: { message: '双层' } } })))
      .toEqual([{ type: 'error', error: '双层' }])
    expect(parseOpenAICompatSSE(JSON.stringify({ error: 42 })))
      .toEqual([{ type: 'error', error: '42' }])
  })

  test('Given 非法 JSON When 解析 Then 返回空数组', () => {
    expect(parseOpenAICompatSSE('not-json')).toEqual([])
  })
})

describe('PromaAdapter', () => {
  test('Given 适配器 When 读取 providerType Then 为 proma（未注册进 registry）', () => {
    const adapter = new PromaAdapter()
    expect(adapter.providerType).toBe('proma')
  })

  test('Given 适配器与纯函数 When 构建同一输入 Then 结果一致', () => {
    const adapter = new PromaAdapter()
    const request = input({ thinkingEnabled: true })
    expect(adapter.buildStreamRequest(request)).toEqual(buildPromaStreamRequest(request))
    expect(adapter.buildTitleRequest({ baseUrl: 'https://a.test/api/v1', apiKey: 'k', modelId: 'm', prompt: 'p' }))
      .toEqual(buildPromaTitleRequest({ baseUrl: 'https://a.test/api/v1', apiKey: 'k', modelId: 'm', prompt: 'p' }))
    expect(adapter.parseSSELine('{"choices":[{"delta":{"content":"x"}}]}'))
      .toEqual([{ type: 'chunk', delta: 'x' }])
    expect(adapter.parseTitleResponse({ choices: [{ message: { content: 't' } }] })).toBe('t')
  })

  test('Given 现有 OpenAIAdapter When 解析 finish_reason=stop Then 保持原有行为（不发 done）', () => {
    const events = new OpenAIAdapter().parseSSELine(JSON.stringify({
      choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
    }))
    expect(events).toEqual([{ type: 'chunk', delta: 'x' }])
  })
})
