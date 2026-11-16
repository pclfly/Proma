import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { AgentContextRequestPolicy } from '../agent-context-request-policy'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
export type ContextCompactionCancellation = 'fits' | 'preparation_failed'
interface ContextCompactionOptions {
  sdk: Pick<PiSdk, 'estimateTokens' | 'shouldCompact'>
  policy: AgentContextRequestPolicy
  projectRequest: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  getSettings: () => Parameters<PiSdk['shouldCompact']>[2]
  additionalPromptChars: number
  onCancel?: (reason: ContextCompactionCancellation) => void
}

export function getContextCompactionCancellationStatus(reason?: ContextCompactionCancellation): {
  compact_result: 'noop' | 'failed'; message?: string; compact_error?: string
} {
  if (reason === 'fits') return { compact_result: 'noop', message: '已按需保留当前材料，无需额外压缩。' }
  return { compact_result: 'failed', compact_error: reason === 'preparation_failed'
    ? '上下文材料准备失败，本次压缩已停止，以免重新发送全部原文。请缩小读取范围。'
    : '上下文压缩已取消。' }
}

/** 在SDK公开的压缩准备事件中投影副本；不改历史、切割位置或原生模型/鉴权/重试链。 */
export function createContextCompactionProjectionExtension(options: ContextCompactionOptions): ExtensionFactory {
  const cancel = (reason: ContextCompactionCancellation): { cancel: true } => {
    try { options.onCancel?.(reason) } catch { /* 状态通知不能使SDK回退原始请求。 */ }
    return { cancel: true }
  }
  return (pi) => {
    pi.on('session_before_compact', async (event, context) => {
      try {
        if (event.reason === 'threshold' && context.model && context.model.contextWindow > 0
          && !String(context.model.api).includes('virtual')) {
          const messages = await options.projectRequest(context.sessionManager.buildSessionProjection().messages, event.signal)
          const hasImages = messages.some((message) => 'content' in message && Array.isArray(message.content)
            && message.content.some((block: unknown) => block && typeof block === 'object' && 'type' in block && block.type === 'image'))
          // 仅在无图片、保守估计仍有足够余量时否决“原始大材料”造成的阈值误报。
          // 图片计费估计因provider而异，不能据固定像素估算屏蔽原生压缩；overflow永不否决。
          const estimated = Math.ceil(messages.reduce((sum, message) => sum + options.sdk.estimateTokens(message), 0) * 1.25)
            + Math.ceil(options.additionalPromptChars / 2) + 4096
          if (!hasImages && !options.sdk.shouldCompact(estimated, context.model.contextWindow, options.getSettings())) {
            return cancel('fits')
          }
        }
        // SDK压缩直接串行化preparation，不经过agent.transformContext。
        // 只替换本次准备对象的两个消息数组；文件操作索引、cut point和原始branch保持不变。
        event.preparation.messagesToSummarize = options.policy.projectForSummary(event.preparation.messagesToSummarize, event.signal)
        event.preparation.turnPrefixMessages = options.policy.projectForSummary(event.preparation.turnPrefixMessages, event.signal)
      } catch {
        // 扩展抛错会被SDK捕获后回退原始请求，因此必须显式取消，不能意外发送全部原文。
        console.warn('[Pi 按需上下文] 压缩副本准备失败，已取消该次压缩以避免发送未投影原文。')
        return cancel('preparation_failed')
      }
    })
  }
}
