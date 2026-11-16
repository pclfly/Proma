import { expect, test } from 'bun:test'
import type { WorkspaceMemoryFileChange } from '@proma/shared'
import { createWorkspaceMemoryWatchSubscriptions } from './workspace-memory-watch-subscriptions'

const change: WorkspaceMemoryFileChange = { relativePath: 'a.md', kind: 'modified', changedAt: 1, diffAvailable: false }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function flush(): Promise<void> { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
function fixture(start?: () => Promise<void>, stop?: () => Promise<void>) {
  const starts: string[] = [], stops: string[] = [], errors: unknown[] = [], listeners = new Map<string, (event: WorkspaceMemoryFileChange) => void>()
  let removed = 0
  const subscriptions = createWorkspaceMemoryWatchSubscriptions({ start: slug => { starts.push(slug); return start?.() ?? Promise.resolve() }, stop: slug => { stops.push(slug); return stop?.() ?? Promise.resolve() }, listen: (slug, callback) => { listeners.set(slug, callback); return () => { listeners.delete(slug); removed += 1 } }, reportError: error => errors.push(error) })
  return { ...subscriptions, starts, stops, errors, listeners, get removed() { return removed } }
}

test('Given 同workspace多个消费者及相同callback When 一个取消 Then 不停别的订阅且最后释放listener', async () => {
  const state = fixture(), received: WorkspaceMemoryFileChange[] = [], callback = (event: WorkspaceMemoryFileChange): void => { received.push(event) }
  const first = state.subscribe('workspace', callback), last = state.subscribe('workspace', callback)
  await flush(); expect(state.starts).toEqual(['workspace'])
  first(); first(); await flush(); expect(state.stops).toHaveLength(0)
  state.listeners.get('workspace')?.(change); expect(received).toHaveLength(1)
  last(); await flush(); expect(state.stops).toEqual(['workspace']); expect(state.removed).toBe(1)
})

test('Given StrictMode start尚未返回 When 卸载再挂载 Then 迟到旧start不关闭新消费者', async () => {
  const start = deferred(), state = fixture(() => start.promise)
  const first = state.subscribe('workspace', () => {}); first()
  const last = state.subscribe('workspace', () => {})
  start.resolve(); await flush()
  expect(state.starts).toHaveLength(1); expect(state.stops).toHaveLength(0)
  last(); await flush(); expect(state.stops).toHaveLength(1); expect(state.removed).toBe(1)
})

test('Given stop尚未返回 When 新消费者进入 Then 等旧stop后重新start且不中途移除listener', async () => {
  const stop = deferred(), state = fixture(undefined, () => stop.promise)
  const first = state.subscribe('workspace', () => {}); await flush(); first()
  const last = state.subscribe('workspace', () => {})
  expect(state.stops).toHaveLength(1); expect(state.removed).toBe(0)
  stop.resolve(); await flush(); expect(state.starts).toHaveLength(2); expect(state.removed).toBe(0)
  last(); await flush(); expect(state.removed).toBe(1)
})

test('Given start失败 When 保持消费者并新增订阅 Then 显式报告失败且可再次启动不死循环', async () => {
  let attempts = 0
  const failure = new Error('synthetic start denied'), observedErrors: unknown[] = []
  const state = fixture(() => ++attempts === 1 ? Promise.reject(failure) : Promise.resolve())
  const first = state.subscribe('workspace', () => {}, error => observedErrors.push(error))
  await flush(); expect(attempts).toBe(1); expect(state.errors).toEqual([failure]); expect(observedErrors).toEqual([failure])
  const last = state.subscribe('workspace', () => {}); await flush(); expect(attempts).toBe(2)
  first(); last(); await flush(); expect(state.stops).toHaveLength(1); expect(state.removed).toBe(1)
})

test('Given stop失败 When 之后再次订阅与释放 Then 收敛并最终清理listener而非复用死订阅', async () => {
  let stops = 0
  const state = fixture(undefined, () => ++stops === 1 ? Promise.reject(new Error('synthetic stop denied')) : Promise.resolve())
  const first = state.subscribe('workspace', () => {})
  await flush()
  first() // stop 失败 → unknown，listener 与 entry 暂留，错误显式上报
  await flush()
  expect(state.errors.length).toBe(1)
  expect(state.removed).toBe(0)
  const second = state.subscribe('workspace', () => {})
  await flush()
  second()
  await flush()
  expect(stops).toBe(2)
  expect(state.removed).toBe(1)
})
