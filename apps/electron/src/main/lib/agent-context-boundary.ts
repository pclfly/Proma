/** 图片与文本共用的业务轮次边界；完整内部压缩续接不是新的用户任务。 */
export function findLatestExplicitUserIndex<T extends { role?: unknown; content?: unknown }>(messages: readonly T[], internalUserPrompt?: string): number {
  return messages.findLastIndex((message) => {
    if (message.role !== 'user') return false
    if (!internalUserPrompt) return true
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.map((block: unknown) => block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : '').join('') : ''
    // 普通用户只提到标记不能跳过边界；提示正文必须完整且只跟输出格式后缀。
    if (!text.startsWith(internalUserPrompt)) return true
    const suffix = text.slice(internalUserPrompt.length).trim()
    return suffix !== '' && !/^<output_format>[\s\S]*<\/output_format>$/.test(suffix)
  })
}
