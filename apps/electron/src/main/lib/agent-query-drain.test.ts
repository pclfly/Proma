import { describe, expect, test } from 'bun:test'
import { serializeAgentRuntimeError } from '@proma/shared'
import { AgentQueryDrain, AgentQueryDrainError } from './agent-query-drain'
import { createPiSessionCleanup } from './adapters/pi-session-cleanup'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('Agent query 真实清理屏障', () => {
  for (const stage of ['dispose', 'dispatcher'] as const) {
    test(`Given 自然next进入finally的${stage}失败 When 后续close Then 不能把已关闭generator的return当作清理成功`, async () => {
      const cleanup = createPiSessionCleanup({
        waitForProducer: async () => {},
        dispose: () => { if (stage === 'dispose') throw new Error('dispose failed') },
        closeDispatcher: async () => { if (stage === 'dispatcher') throw new Error('dispatcher failed') },
        release: () => {},
      })
      const drain = new AgentQueryDrain({ async *[Symbol.asyncIterator]() {
        try { yield 'terminal' } finally { await cleanup() }
      } }, () => {})
      await drain.next()
      await expect(drain.next()).rejects.toThrow()
      await expect(drain.close()).rejects.toBeInstanceOf(AgentQueryDrainError)
    })
  }
  test('Given utility结构化传输后的清理错误 When 自然next拒绝 Then 不依赖跨进程instanceof仍保留失败', async () => {
    const serialized = structuredClone(serializeAgentRuntimeError(new AgentQueryDrainError(new Error('fixture'))))
    const error = Object.assign(new Error(serialized.message), serialized)
    const drain = new AgentQueryDrain({ async *[Symbol.asyncIterator]() { yield 'terminal'; throw error } }, () => {})
    await drain.next()
    await expect(drain.next()).rejects.toThrow()
    await expect(drain.close()).rejects.toBeInstanceOf(AgentQueryDrainError)
  })

  test('Given terminal后next悬空 When 超时关闭 Then 依次等abort、next和return的finally', async () => {
    const aborted = deferred<void>()
    const next = deferred<IteratorResult<string>>()
    const returned = deferred<void>()
    const returning = deferred<void>()
    let abortCount = 0
    let returnCount = 0
    let closed = false
    const drain = new AgentQueryDrain<string>({ [Symbol.asyncIterator]: () => ({
      next: () => next.promise,
      return: async () => { returnCount++; returning.resolve(); await returned.promise; return { done: true, value: undefined } },
    }) }, async () => { abortCount++; await aborted.promise })
    void drain.next()
    const close = drain.close().then(() => { closed = true })
    expect(drain.close()).toBe(drain.close())
    await tick()
    expect(abortCount).toBe(1)
    expect(returnCount).toBe(0)
    aborted.resolve()
    await tick()
    expect(returnCount).toBe(0)
    next.resolve({ done: true, value: undefined })
    await returning.promise
    expect(closed).toBe(false)
    returned.resolve()
    await close
    expect(returnCount).toBe(1)
    expect(closed).toBe(true)
  })

  test('Given 自然done When finally收束 Then 不额外abort或return已结束的query', async () => {
    let abortCount = 0
    let returnCount = 0
    const drain = new AgentQueryDrain<string>({ [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
      return: async () => { returnCount++; return { done: true, value: undefined } },
    }) }, () => { abortCount++ })
    expect((await drain.next()).done).toBe(true)
    await drain.close()
    expect(abortCount).toBe(0)
    expect(returnCount).toBe(0)
  })

  test('Given 处理消息提前退出 When 多个关闭入口同时到达 Then 幂等执行一次清理', async () => {
    let abortCount = 0
    let returnCount = 0
    const drain = new AgentQueryDrain<string>({ [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: 'result' }),
      return: async () => { returnCount++; return { done: true, value: undefined } },
    }) }, () => { abortCount++ })
    await drain.next()
    await Promise.all([drain.close(), drain.close()])
    expect(abortCount).toBe(1)
    expect(returnCount).toBe(1)
    await expect(drain.next()).rejects.toThrow('正在关闭')
  })

  for (const failure of ['abort', 'return'] as const) {
    test(`Given ${failure}清理失败 When 请求关闭 Then 返回专用错误而不是假报已结束`, async () => {
      const drain = new AgentQueryDrain<string>({ [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: 'result' }),
        return: async () => { if (failure === 'return') throw new Error('fixture'); return { done: true, value: undefined } },
      }) }, () => { if (failure === 'abort') throw new Error('fixture') })
      await drain.next()
      const close = drain.close()
      await expect(close).rejects.toBeInstanceOf(AgentQueryDrainError)
      expect(drain.close()).toBe(close)
    })
  }

  test('Given next已拒绝 When finally关闭 Then 仍执行return而不跳过adapter清理', async () => {
    let returned = false
    const drain = new AgentQueryDrain<string>({ [Symbol.asyncIterator]: () => ({
      next: async () => { throw new Error('流失败') },
      return: async () => { returned = true; return { done: true, value: undefined } },
    }) }, () => {})
    await expect(drain.next()).rejects.toThrow('流失败')
    await drain.close()
    expect(returned).toBe(true)
  })
})
