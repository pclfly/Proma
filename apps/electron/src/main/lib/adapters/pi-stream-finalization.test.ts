import { describe, expect, test } from 'bun:test'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { getModel, isRetryableAssistantError, retryAssistantCall } from '@earendil-works/pi-ai/compat'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { runAgentLoop, runAgentLoopContinue } from '@earendil-works/pi-agent-core'
import type { AgentContext, AgentLoopConfig, StreamFn } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { withPiStreamFinalizationGuard } from './pi-stream-finalization'

const model = getModel('openai', 'gpt-4o')!
const context = normalizeContext({ messages: [] })
function message(text = 'partial'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
const hanging = (partial = message()): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: 'start', partial })
  stream.end()
  return stream
}
const completed = (result = message('final')): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: 'done', reason: 'stop', message: result })
  return stream
}

describe('Pi provider 流收尾保护', () => {
  test('Given lazyStream可信终态但result悬空 When 结束 Then observer恰好收到一次终态', async () => {
    const source = completed()
    source.result = () => new Promise(() => {})
    const observed: (AssistantMessage | undefined)[] = []
    const events: string[] = []
    const stream = lazyStream(model, async () => source, {
      onEvent: (event) => events.push(event.type),
      onResult: (result) => observed.push(result),
    })
    const result = await stream.result()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observed).toEqual([result])
    expect(events).toEqual(['done'])
  })
  test.each(['reject', 'hang'] as const)('Given 终态后迭代器清理%s When lazyStream收尾 Then 不产生第二个终态', async (cleanup) => {
    const final = message('trusted')
    const observed: (AssistantMessage | undefined)[] = []
    const events: string[] = []
    const source: AsyncIterable<import('@earendil-works/pi-ai').AssistantMessageEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: { type: 'done', reason: 'stop', message: final } }),
        return: async () => {
          if (cleanup === 'reject') throw new Error('iterator cleanup failed')
          return new Promise(() => {})
        },
      }),
    }
    const stream = lazyStream(model, async () => source, {
      onEvent: (event) => events.push(event.type), onResult: (result) => observed.push(result),
    })
    expect(await stream.result()).toBe(final)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['done'])
    expect(observed).toEqual([final])
  })
  test('Given EOF后result拒绝 When lazyStream收尾 Then 保留partial且通知error与result一次', async () => {
    const source = hanging(message('retain me'))
    source.result = async () => { throw new Error('stream_read_error') }
    const observed: (AssistantMessage | undefined)[] = []
    const events: string[] = []
    const stream = lazyStream(model, async () => source, {
      onEvent: (event) => events.push(event.type),
      onResult: (result) => observed.push(result),
    })
    const result = await stream.result()
    expect(result.content).toEqual(message('retain me').content)
    expect(result.stopReason).toBe('error')
    expect(events).toEqual(['start', 'error'])
    expect(observed).toEqual([result])
  })
  test('Given EOF有result而无终态事件 When lazyStream收尾 Then observer收到原结果', async () => {
    const source = hanging()
    const final = message('result only')
    source.result = async () => final
    const observed: (AssistantMessage | undefined)[] = []
    const stream = lazyStream(model, async () => source, { onResult: (result) => observed.push(result) })
    expect(await stream.result()).toBe(final)
    expect(observed).toEqual([final])
  })
  test('Given 真正ModelRuntime加lazyApi嵌套 When 底层EOF悬空 Then 原生链路可恢复', async () => {
    const runtime = Object.create(ModelRuntime.prototype) as ModelRuntime
    // 只替换认证/解析，不替换真实streamSimple和lazyStream实现。
    Object.defineProperty(runtime, 'prepareRequest', { value: async () => ({ model, options: {}, provider: {
      streamSimple: () => lazyStream(model, async () => hanging()),
    } }) })
    const guarded = await withPiStreamFinalizationGuard((requestModel, requestContext, options) => runtime.streamSimple(requestModel, requestContext, options), 2)
    const result = await (await guarded(model, context)).result()
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(true)
    expect(result.content).toEqual(message().content)
  }, 15_000)
  test('Given EOF无result When 超时 Then partial保留并交给原生重试', async () => {
    const guarded = await withPiStreamFinalizationGuard(() => hanging(), 2)
    const result = await (await guarded(model, context)).result()
    expect(result.content).toEqual(message().content)
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(true)
  })
  test('Given 可信done但result悬空 When 收尾 Then 保留成功不重试', async () => {
    const source = completed()
    source.result = () => new Promise(() => {})
    const result = await (await (await withPiStreamFinalizationGuard(() => source, 2))(model, context)).result()
    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual(message('final').content)
  })
  test('Given 终态含不可复制扩展字段 When 结算 Then 保留正文并明确失败而非悬空或执行工具', async () => {
    const final = Object.assign(message('safe text'), { providerExtension: () => 'not cloneable' })
    final.content.push({ type: 'toolCall', id: 'unsafe', name: 'write', arguments: {} })
    const result = await (await (await withPiStreamFinalizationGuard(() => completed(final), 2))(model, context)).result()
    expect(result.stopReason).toBe('error')
    expect(result.content).toEqual(message('safe text').content)
    expect(result.errorMessage).toContain('provider_result_serialization_error')
    expect(isRetryableAssistantError(result)).toBe(false)
  })
  test('Given 尚未结束的旧迭代器 When 取消后收到done Then 旧终态被忽略且清理完成', async () => {
    const controller = new AbortController()
    let deliver: ((event: IteratorResult<import('@earendil-works/pi-ai').AssistantMessageEvent>) => void) | undefined
    let returns = 0
    let providerSignal: AbortSignal | undefined
    const source = new AssistantMessageEventStream()
    source[Symbol.asyncIterator] = () => ({
      next: () => new Promise((resolve) => { deliver = resolve }),
      return: async () => { returns++; return { done: true as const, value: undefined } },
    })
    const stream = await (await withPiStreamFinalizationGuard((_model, _context, options) => { providerSignal = options?.signal; return source }))(model, context, { signal: controller.signal })
    controller.abort()
    const result = await stream.result()
    deliver?.({ done: false, value: { type: 'done', reason: 'stop', message: message('late') } })
    await Promise.resolve()
    expect((await stream.result()).stopReason).toBe('aborted')
    expect(await stream.result()).toEqual(result)
    expect(providerSignal?.aborted).toBe(true)
    expect(returns).toBe(1)
  })
  test('Given 收尾中取消和迟到done When 取消 Then aborted且不再修改结果', async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const source = hanging()
    const guarded = await withPiStreamFinalizationGuard((_model, _context, options) => { providerSignal = options?.signal; return source }, 50)
    const stream = await guarded(model, context, { signal: controller.signal })
    controller.abort()
    const result = await stream.result()
    source.push({ type: 'done', reason: 'stop', message: message('late') })
    expect(result.stopReason).toBe('aborted')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(providerSignal?.aborted).toBe(true)
    expect(await stream.result()).toEqual(result)
  })
  test('Given 开始前已取消 When 包装调用 Then 不请求provider', async () => {
    let calls = 0
    const controller = new AbortController(); controller.abort()
    const result = await (await (await withPiStreamFinalizationGuard(() => { calls++; return completed() }))(model, context, { signal: controller.signal })).result()
    expect(calls).toBe(0)
    expect(result.stopReason).toBe('aborted')
  })
  test('Given 持续收尾失败 When native预算耗尽 Then 无嵌套重试倍增', async () => {
    let calls = 0
    const guard = await withPiStreamFinalizationGuard(() => { calls++; return hanging() }, 1)
    const result = await retryAssistantCall(async () => (await guard(model, context)).result(), { enabled: true, maxRetries: 2, baseDelayMs: 0 }, undefined)
    expect(calls).toBe(3)
    expect(result.stopReason).toBe('error')
  })
  test('Given 中文收尾超时与普通业务错误 When 归一化 Then 仅前者可重试', async () => {
    for (const [errorMessage, retryable] of [['流式响应收尾超时', true], ['持久化配置失败', false]] as const) {
      const source = new AssistantMessageEventStream()
      source.push({ type: 'error', reason: 'error', error: { ...message(), stopReason: 'error', errorMessage } })
      expect(isRetryableAssistantError(await (await (await withPiStreamFinalizationGuard(() => source))(model, context)).result())).toBe(retryable)
    }
  })
  test('Given 已完成工具后下一流悬空 When transcript继续 Then 工具不重放且失败toolCall不执行', async () => {
    let calls = 0, executions = 0
    const transcript: AgentContext = { messages: [], tools: [{ name: 'write', label: 'write', description: 'fake', parameters: Type.Object({}), execute: async () => { executions++; return { content: [{ type: 'text', text: 'saved' }], details: {} } } }] }
    const config: AgentLoopConfig = { model, convertToLlm: (messages) => messages as TranscriptContext['messages'] }
    const provider: StreamFn = (_model, request) => {
      calls++
      if (calls === 1) return completed({ ...message(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'one', name: 'write', arguments: {} }] })
      if (calls === 2) return hanging({ ...message(), content: [{ type: 'toolCall', id: 'unfinished', name: 'write', arguments: {} }] })
      expect(request.messages.some((item) => item.role === 'toolResult')).toBe(true)
      return completed()
    }
    const guard = await withPiStreamFinalizationGuard(provider, 1)
    const emitted: AssistantMessage[] = []
    const sink = (event: import('@earendil-works/pi-agent-core').AgentEvent): void => { if (event.type === 'message_end' && event.message.role === 'assistant') emitted.push(event.message) }
    transcript.messages = await runAgentLoop([{ role: 'user', content: [{ type: 'text', text: 'do it' }], timestamp: 1 }], transcript, config, sink, undefined, guard)
    expect(executions).toBe(1)
    expect(emitted.at(-1)?.stopReason).toBe('error')
    // Pi native retry 的投影会省略失败assistant，保留用户和已完成工具结果。
    transcript.messages = transcript.messages.filter((item) => item.role !== 'assistant' || item.stopReason !== 'error')
    await runAgentLoopContinue(transcript, config, sink, undefined, guard)
    expect(executions).toBe(1)
    expect(calls).toBe(3)
    expect(transcript.messages.filter((item) => item.role === 'user')).toHaveLength(1)
    expect(emitted.at(-1)?.stopReason).toBe('stop')
  })
})

describe('Pi provider 终态预算与计时观察', () => {
  test('Given provider先给正文再结束 When 结算 Then 回调恰好一次且记录首文本与总耗时', async () => {
    const source = new AssistantMessageEventStream()
    const final = message('hello')
    source.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial: final })
    source.push({ type: 'done', reason: 'stop', message: final })
    const observed: import('./pi-stream-finalization').PiStreamMetrics[] = []
    const guard = await withPiStreamFinalizationGuard(() => source, 2, (result, metrics) => { observed.push(metrics); return result })
    expect((await (await guard(model, context)).result()).stopReason).toBe('stop')
    expect(observed).toHaveLength(1)
    expect(observed[0]!.firstTextMs).toBeGreaterThanOrEqual(0)
    expect(observed[0]!.durationMs).toBeGreaterThanOrEqual(observed[0]!.firstTextMs!)
  })
  test('Given EOF悬空 When guard生成错误 Then 同样经过失败预算而非漏记', async () => {
    let calls = 0
    const guard = await withPiStreamFinalizationGuard(() => hanging(), 1, (result) => {
      calls++
      return { ...result, errorMessage: 'proma_request_failure_budget_exhausted: 已停止自动恢复' }
    })
    const result = await (await guard(model, context)).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('proma_request_failure_budget_exhausted')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(calls).toBe(1)
  })
  test('Given 终态结算回调抛错 When 完成 Then 明确失败而非悬空', async () => {
    const guard = await withPiStreamFinalizationGuard(() => completed(), 1, () => { throw new Error('observer failure') })
    const result = await (await guard(model, context)).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('provider_result_finalizer_error')
    expect(isRetryableAssistantError(result)).toBe(false)
  })
})
