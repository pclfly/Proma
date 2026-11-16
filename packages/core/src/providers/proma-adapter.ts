/**
 * Proma 官方渠道适配器（Cloud）
 *
 * 从官方 0.22.0 `packages/core/src/providers/proma-adapter.ts` 移植协议层：
 * - 请求地址：`{baseUrl}/chat`（baseUrl 已含 `/api/v1`）
 * - 请求体额外携带 `thinkingEnabled`
 * - 历史 assistant 消息回传 `reasoning_content`（仅在 thinking 开启时对续接消息生效）
 * - SSE 使用 OpenAI 兼容格式，但额外识别 `error` 字段，并在任意 finish_reason 上结束
 *
 * 注意：本轮**不**把 `proma` 注册进 `adapterRegistry`，也不扩展 `ProviderType`。
 * 原因是本地 ProviderType 还驱动渠道配置、默认地址与设置页；注册会改变现有
 * provider 的选择/校验行为。等主进程 Cloud 登录态与官方渠道同步落地后再接入。
 */

import type {
  ContinuationMessage,
  ImageAttachmentData,
  ProviderRequest,
  StreamEvent,
  StreamRequestInput,
  TitleRequestInput,
} from './types.ts'
import { toOpenAITools } from './openai-adapter.ts'

// ===== Proma 协议消息类型 =====

/** Proma 内容块（与 OpenAI 多模态格式一致） */
interface PromaContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** Proma tool_call 格式 */
interface PromaToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Proma 消息格式 */
export interface PromaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | PromaContentBlock[] | null
  reasoning_content?: string
  tool_calls?: PromaToolCall[]
  tool_call_id?: string
}

/** Proma SSE 数据块（OpenAI 兼容 + error 字段） */
interface PromaChunkData {
  error?: unknown
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

/** Proma 标题响应 */
interface PromaTitleResponse {
  choices?: Array<{ message?: { content?: string } }>
}

// ===== 消息转换 =====

/** 将图片附件转换为 OpenAI 图片块 */
export function buildImageBlocks(imageData: ImageAttachmentData[]): PromaContentBlock[] {
  return imageData.map((img) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${img.mediaType};base64,${img.data}` },
  }))
}

/** 构建包含图片和文本的消息内容 */
export function buildMessageContent(
  text: string,
  imageData: ImageAttachmentData[],
): string | PromaContentBlock[] {
  if (imageData.length === 0) return text

  const content: PromaContentBlock[] = buildImageBlocks(imageData)
  if (text) {
    content.push({ type: 'text', text })
  }
  return content
}

/**
 * 将统一消息历史转换为 Proma 格式。
 *
 * 与官方一致：assistant 历史消息的附件会转成图片块并保留 reasoning_content；
 * 无附件时 reasoning_content 直接回传。
 */
export function toPromaMessages(input: StreamRequestInput): PromaMessage[] {
  const { history, userMessage, systemMessage, attachments, readImageAttachments } = input
  const messages: PromaMessage[] = []

  if (systemMessage) {
    messages.push({ role: 'system', content: systemMessage })
  }

  for (const msg of history) {
    if (msg.role === 'system') continue
    const role = msg.role === 'assistant' ? 'assistant' as const : 'user' as const

    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      const historyImages = readImageAttachments(msg.attachments)
      messages.push({ role, content: buildMessageContent(msg.content, historyImages) })
    } else if (msg.role === 'assistant' && msg.attachments && msg.attachments.length > 0) {
      const assistantImages = readImageAttachments(msg.attachments)
      const content = buildImageBlocks(assistantImages)
      if (msg.content) {
        content.push({ type: 'text', text: msg.content })
      }
      const openaiMsg: PromaMessage = { role, content }
      if (msg.reasoning) openaiMsg.reasoning_content = msg.reasoning
      messages.push(openaiMsg)
    } else {
      const openaiMsg: PromaMessage = { role, content: msg.content }
      if (msg.role === 'assistant' && msg.reasoning) {
        openaiMsg.reasoning_content = msg.reasoning
      }
      messages.push(openaiMsg)
    }
  }

  const currentImages = readImageAttachments(attachments)
  messages.push({
    role: 'user',
    content: buildMessageContent(userMessage, currentImages),
  })

  return messages
}

/**
 * 将工具续接消息追加到 Proma 消息列表。
 *
 * `thinkingEnabled` 为 true 时，assistant 续接消息会带回 reasoning_content；
 * 关闭时剔除，避免向不支持思考回传的端点发送额外字段。
 */
export function appendPromaContinuationMessages(
  messages: PromaMessage[],
  continuationMessages: ContinuationMessage[],
  thinkingEnabled: boolean,
): void {
  for (const contMsg of continuationMessages) {
    if (contMsg.role === 'assistant') {
      const assistantMsg: PromaMessage = {
        role: 'assistant',
        content: contMsg.content || null,
        tool_calls: contMsg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      }
      if (thinkingEnabled && contMsg.reasoning && contMsg.reasoning.length > 0) {
        assistantMsg.reasoning_content = contMsg.reasoning
      }
      messages.push(assistantMsg)
    } else if (contMsg.role === 'tool') {
      for (const result of contMsg.results) {
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.toolCallId,
        })
      }
    }
  }
}

// ===== SSE 解析 =====

/**
 * OpenAI 兼容 SSE 解析（官方 0.22.0 版本）。
 *
 * 与本地 OpenAIAdapter.parseSSELine 的差异：
 * - 识别 `error` 字段并转成 error 事件；
 * - 任意 `finish_reason` 都结束（tool_calls 映射为 stopReason: 'tool_use'）。
 *
 * 为保持现有 provider 行为不变，这里单独实现，不改动 OpenAIAdapter。
 */
export function parseOpenAICompatSSE(jsonLine: string): StreamEvent[] {
  try {
    const chunk = JSON.parse(jsonLine) as PromaChunkData
    const errorField = chunk.error
    if (errorField) {
      let errorMessage: string
      if (typeof errorField === 'string') {
        errorMessage = errorField
      } else if (typeof errorField === 'object' && errorField !== null) {
        const errObj = errorField as { error?: { message?: string }; message?: string }
        errorMessage = errObj.error?.message ?? errObj.message ?? JSON.stringify(errorField)
      } else {
        errorMessage = String(errorField)
      }
      return [{ type: 'error', error: errorMessage }]
    }

    const delta = chunk.choices?.[0]?.delta
    const events: StreamEvent[] = []

    if (delta?.content) {
      events.push({ type: 'chunk', delta: delta.content })
    }
    if (delta?.reasoning_content) {
      events.push({ type: 'reasoning', delta: delta.reasoning_content })
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          events.push({
            type: 'tool_call_start',
            toolCallId: tc.id || `tc_${tc.index ?? 0}`,
            toolName: tc.function.name,
          })
        }
        if (tc.function?.arguments) {
          events.push({
            type: 'tool_call_delta',
            toolCallId: tc.id || '',
            argumentsDelta: tc.function.arguments,
          })
        }
      }
    }

    const finishReason = chunk.choices?.[0]?.finish_reason
    if (finishReason) {
      events.push({
        type: 'done',
        ...(finishReason === 'tool_calls' ? { stopReason: 'tool_use' as const } : {}),
      })
    }

    return events
  } catch {
    return []
  }
}

// ===== 请求构建 =====

/** 构建 Proma 流式请求（纯函数） */
export function buildPromaStreamRequest(input: StreamRequestInput): ProviderRequest {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const messages = toPromaMessages(input)
  const bodyObj: Record<string, unknown> = {
    model: input.modelId,
    messages,
    stream: true,
    thinkingEnabled: input.thinkingEnabled ?? false,
  }

  if (input.tools && input.tools.length > 0) {
    bodyObj.tools = toOpenAITools(input.tools)
  }

  if (input.continuationMessages && input.continuationMessages.length > 0) {
    appendPromaContinuationMessages(messages, input.continuationMessages, !!input.thinkingEnabled)
  }

  return {
    url: `${baseUrl}/chat`,
    headers: {
      'Authorization': `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  }
}

/**
 * 构建标题请求（纯函数）。
 *
 * 与官方一致：从 `.../api/v1` 回退到根域，再请求 `/v1/chat/completions`。
 */
export function buildPromaTitleRequest(input: TitleRequestInput): ProviderRequest {
  const rootUrl = input.baseUrl.trim().replace(/\/+$/, '').replace(/\/api\/v\d+$/, '')
  return {
    url: `${rootUrl}/v1/chat/completions`,
    headers: {
      'Authorization': `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelId,
      messages: [{ role: 'user', content: input.prompt }],
      stream: false,
    }),
  }
}

/** 从标题响应中提取文本；缺失时返回 null。 */
export function parsePromaTitleResponse(responseBody: unknown): string | null {
  const data = responseBody as PromaTitleResponse
  return data.choices?.[0]?.message?.content ?? null
}

// ===== 适配器 =====

/**
 * Proma 适配器接口
 *
 * 与 `ProviderAdapter` 结构一致，但 `providerType` 固定为 'proma'，
 * 避免在未扩展 ProviderType 之前污染注册表类型。
 */
export interface PromaProviderAdapter {
  readonly providerType: 'proma'
  buildStreamRequest(input: StreamRequestInput): ProviderRequest
  parseSSELine(jsonLine: string): StreamEvent[]
  buildTitleRequest(input: TitleRequestInput): ProviderRequest
  parseTitleResponse(responseBody: unknown): string | null
}

export class PromaAdapter implements PromaProviderAdapter {
  readonly providerType = 'proma' as const

  buildStreamRequest(input: StreamRequestInput): ProviderRequest {
    return buildPromaStreamRequest(input)
  }

  parseSSELine(jsonLine: string): StreamEvent[] {
    return parseOpenAICompatSSE(jsonLine)
  }

  buildTitleRequest(input: TitleRequestInput): ProviderRequest {
    return buildPromaTitleRequest(input)
  }

  parseTitleResponse(responseBody: unknown): string | null {
    return parsePromaTitleResponse(responseBody)
  }
}
