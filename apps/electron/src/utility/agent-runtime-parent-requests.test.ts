import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, createAgentRuntimeResponse } from '@proma/shared'
import type { AgentRuntimeRequest } from '@proma/shared'
import { ParentCapabilityRequests } from './agent-runtime-parent-requests'

function fixture() {
  let now = 0, next = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const sent: AgentRuntimeRequest[] = []
  const requests = new ParentCapabilityRequests({
    transport: () => ({ bootId: 'fixture', queryId: 'query', sessionId: 'parent', postMessage: (request) => { sent.push(request) } }),
    schedule: (callback, delay) => {
      const id = ++next
      timers.set(id, { at: now + delay, callback })
      return () => { timers.delete(id) }
    },
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
  }
  return { requests, timers, sent, advance }
}

describe('utility父能力请求实际调度', () => {
  test('Given 一小时协作wait When 超过旧120秒 Then 请求仍等待，正常响应清理timer', async () => {
    const f = fixture()
    const pending = f.requests.request(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'mcp__collaboration__wait_for_delegations', input: { timeoutSeconds: 3600 } })
    f.advance(120_001)
    expect(f.requests.size).toBe(1)
    expect(f.sent).toHaveLength(1)
    f.requests.resolve(createAgentRuntimeResponse(f.sent[0]!, { payload: { status: 'completed' } }))
    expect(await pending).toEqual({ status: 'completed' })
    expect(f.requests.size).toBe(0)
    expect(f.timers.size).toBe(0)
  })
  test('Given wait超过专属期限 When 计时器触发 Then 取消远端并保留定位和未知接收状态', async () => {
    const f = fixture()
    const pending = f.requests.request(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'mcp__collaboration__wait_for_delegations', toolCallId: 'call-id', input: { timeoutSeconds: 7200 } }).catch((error: Error & { acceptance?: string }) => error)
    f.advance(7_230_000)
    const error = await pending as Error & { acceptance?: string }
    expect(error.message).toContain('toolCallId=call-id')
    expect(error.acceptance).toBe('unknown')
    expect(f.sent.at(-1)?.method).toBe(AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL)
    expect(f.requests.size).toBe(0)
    expect(f.timers.size).toBe(0)
  })
  test('Given 父取消与迟到响应 When RPC已发出 Then 一次结算并删除等待timer', async () => {
    const f = fixture(), controller = new AbortController()
    const pending = f.requests.request(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'mcp__collaboration__wait_for_delegations' }, controller.signal).catch((error: Error) => error.name)
    controller.abort()
    expect(await pending).toBe('AbortError')
    f.requests.resolve(createAgentRuntimeResponse(f.sent[0]!, { payload: 'late' }))
    expect(f.requests.size).toBe(0)
    expect(f.timers.size).toBe(0)
    expect(f.sent).toHaveLength(2)
  })
  test('Given 已取消或transport同步失败 When 发出请求 Then 不遗留timer', async () => {
    const f = fixture(), controller = new AbortController()
    controller.abort()
    await expect(f.requests.request('test', {}, controller.signal)).rejects.toThrow('aborted')
    expect(f.sent.every((request) => request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL)).toBe(true)
    expect(f.timers.size).toBe(0)
    const broken = new ParentCapabilityRequests({ transport: () => ({ bootId: 'fixture', postMessage: () => { throw new Error('closed port') } }) })
    await expect(broken.request('test', {})).rejects.toThrow('closed port')
    expect(broken.size).toBe(0)
  })
})
