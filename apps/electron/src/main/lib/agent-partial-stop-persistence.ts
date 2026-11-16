import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'

/** 是否存在非空文本块；与 pi-message-adapter 的判定保持一致，但不依赖可被测试 mock 的模块。 */
function hasAssistantText(message: SDKAssistantMessage): boolean {
  const content = message.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block) => block.type === 'text' && 'text' in block && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/**
 * 停止时把最后的流式预览帧补成正式 assistant 消息。
 *
 * Pi 的 `message_update` 用 `_partial` 标记预览帧，帧内是当前累计全文；
 * 这类帧只用于 UI upsert，`persistSDKMessages` 会过滤掉它。用户手动停止时
 * iterator 常常在 `result` 之前结束，最后一段已生成文本就只存在于预览帧里，
 * 直接落盘会丢掉它——表现为「停止后已生成的部分回复消失、追问接不上」。
 *
 * 返回需要追加进落盘批次的消息；没有可补内容时返回 undefined。
 */
export function absorbPartialAssistantForStop(
  partial: SDKAssistantMessage | undefined,
  stoppedByUser: boolean,
): SDKMessage | undefined {
  if (!stoppedByUser || !partial) return undefined
  if (!hasAssistantText(partial)) return undefined
  const copy = { ...partial, _partial: false } as SDKAssistantMessage & { _partial?: boolean }
  // 停止/失败常伴随传输层 error；落盘应只保留已生成正文，错误由单独的 TypedError 消息表达。
  delete (copy as { error?: unknown }).error
  return copy
}
