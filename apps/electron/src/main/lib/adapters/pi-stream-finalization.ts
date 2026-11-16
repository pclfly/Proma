import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

export const PI_STREAM_FINALIZATION_TIMEOUT_MS = 10_000

export interface PiStreamMetrics {
  durationMs: number
  firstEventMs?: number
  firstTextMs?: number
}

type EventStreamModule = typeof import('@earendil-works/pi-ai/utils/event-stream')

let eventStreamModule: Promise<EventStreamModule> | undefined

/**
 * Pi SDK 是 ESM-only（exports 只声明 import 条件），而主进程产物是 CJS：静态 import
 * 会被 esbuild 编译成 require()，打包后启动即 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 与仓库其它 pi-* 用法一致，走动态 import 让 Node 自己按 ESM 解析。
 */
export function loadPiAssistantMessageEventStream(): Promise<EventStreamModule> {
  eventStreamModule ??= import('@earendil-works/pi-ai/utils/event-stream')
  return eventStreamModule
}

function normalizeFinalizationError(message: AssistantMessage): AssistantMessage {
  if (message.stopReason !== 'error' || !/流式(?:响应|输出)?(?:收尾|结束).*超时/u.test(message.errorMessage ?? '')) return message
  return { ...message, errorMessage: `stream_finalization_timeout: ${message.errorMessage}` }
}

/**
 * 只封装模型 provider 流，不重新调用 prompt 或工具。EOF 后悬空的 result 转为
 * Pi native retry 认识的失败 assistant；已有 done 直接采信，不等待网络清理。
 * 所有重试仍由同一 transcript 的原生有限预算管理。
 */
export async function withPiStreamFinalizationGuard(
  provider: StreamFn,
  timeoutMs = PI_STREAM_FINALIZATION_TIMEOUT_MS,
  finalize?: (message: AssistantMessage, metrics: PiStreamMetrics) => AssistantMessage,
): Promise<StreamFn> {
  const { AssistantMessageEventStream } = await loadPiAssistantMessageEventStream()
  return (model, context, options) => {
    const output = new AssistantMessageEventStream()
    const controller = new AbortController()
    const startedAt = Date.now()
    let firstEventMs: number | undefined
    let firstTextMs: number | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined
    const initialMessage: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    }
    let partial = initialMessage
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abort)
      // return() 或底层 cleanup 可以悬空，不能再次阻塞最终结果。
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* 已封闭旧流 */ }
      controller.abort()
    }
    const finish = (message: AssistantMessage): void => {
      if (settled) return
      let result: AssistantMessage
      try {
        result = normalizeFinalizationError(structuredClone(message))
      } catch {
        // 扩展/provider 的非结构化字段也可能让复制失败；不得先标记 settled 后
        // 留下悬空输出。保留可见正文但不执行无法安全复制的 toolCall。
        result = {
          ...initialMessage,
          content: message.content.flatMap((block): AssistantMessage['content'] => {
            if (block.type === 'text') return [{ type: 'text', text: block.text }]
            if (block.type === 'thinking') return [{ type: 'thinking', thinking: block.thinking }]
            return []
          }),
          stopReason: message.stopReason === 'aborted' ? 'aborted' : 'error',
          errorMessage: 'provider_result_serialization_error: 无法安全复制模型最终消息',
        }
      }
      if (result.stopReason === 'pending') {
        result.stopReason = 'error'
        result.errorMessage = 'stream_finalization_timeout: provider returned a pending final result'
      }
      try {
        result = finalize?.(result, {
          durationMs: Math.max(0, Date.now() - startedAt), firstEventMs, firstTextMs,
        }) ?? result
      } catch {
        // 观察/预算逻辑也不能留下悬空流或让未经验证的工具调用继续执行。
        result = { ...initialMessage, stopReason: 'error', errorMessage: 'provider_result_finalizer_error: 无法安全结算模型响应' }
      }
      // finalizer也不能把已收束结果改回pending。
      if (result.stopReason === 'pending') {
        result.stopReason = 'error'
        result.errorMessage = 'provider_result_finalizer_error: 结算后仍是未完成响应'
      }
      settled = true
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        output.push({ type: 'error', reason: result.stopReason, error: result })
      } else {
        output.push({ type: 'done', reason: result.stopReason, message: result })
      }
      cleanup()
    }
    const abort = (): void => finish({ ...partial, stopReason: 'aborted', errorMessage: 'Request aborted' })
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) { abort(); return output }

    void (async () => {
      const source = await provider(model, context, { ...options, signal: controller.signal })
      iterator = source[Symbol.asyncIterator]()
      if (settled) { cleanup(); return }
      while (!settled) {
        const item = await iterator.next()
        if (settled) return
        if (item.done) break
        const event = item.value
        firstEventMs ??= Math.max(0, Date.now() - startedAt)
        if (event.type === 'text_delta' && event.delta.length > 0) {
          firstTextMs ??= Math.max(0, Date.now() - startedAt)
        }
        // Terminal event 已携带可信最终消息，不依赖 source.result() 再次结算。
        if (event.type === 'done') { finish(event.message); return }
        if (event.type === 'error') { finish(event.error); return }
        partial = event.partial
        output.push(event)
      }
      if (settled) return
      timer = setTimeout(() => finish({
        ...partial, stopReason: 'error', errorMessage: 'stream_finalization_timeout: provider stream ended without a final result',
      }), timeoutMs)
      const result = await source.result()
      if (!settled) finish(result)
    })().catch((error: unknown) => {
      if (settled) return
      if (options?.signal?.aborted) { abort(); return }
      finish({ ...partial, stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error) })
    })
    return output
  }
}
