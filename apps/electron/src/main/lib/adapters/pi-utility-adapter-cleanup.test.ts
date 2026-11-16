import { afterEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, AGENT_RUNTIME_PROTOCOL_VERSION } from '@proma/shared'
import { AgentQueryDrain, AgentQueryDrainError } from '../agent-query-drain'

type EventListener = (event: unknown) => void
let stopFailure: Error | undefined
let queryAbortCompleted = true
let currentListener: EventListener | undefined
let currentQueryId: string | undefined
const clientStops: number[] = []

function endQuery(): void {
  currentListener?.({
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    bootId: 'boot-1',
    kind: 'event',
    method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
    queryId: currentQueryId,
    payload: {},
  })
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 只替换跨进程 client；query 队列、清理顺序与错误分类使用真实适配器代码。 */
mock.module('../agent-runtime-client', () => ({
  AgentRuntimeClient: class {
    setRequestHandler(): void {}
    onEvent(listener: EventListener): () => void { currentListener = listener; return () => { currentListener = undefined } }
    async call(method: string, payload?: { queryId?: string }): Promise<unknown> {
      if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
        currentQueryId = payload?.queryId
        return {}
      }
      if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) return { completed: queryAbortCompleted }
      return {}
    }
    async stop(): Promise<void> {
      clientStops.push(1)
      if (stopFailure) throw stopFailure
    }
  },
}))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')
type QueryInput = import('./pi-agent-adapter').PiAgentQueryOptions
const queryInput = { sessionId: 'fixture-session' } as unknown as QueryInput
const exitUnconfirmed = (): Error => Object.assign(new Error('无法确认 Agent 运行时进程已退出'), { code: 'AGENT_RUNTIME_EXIT_UNCONFIRMED' })

afterEach(() => {
  stopFailure = undefined
  queryAbortCompleted = true
  currentListener = undefined
  currentQueryId = undefined
  clientStops.length = 0
})

describe('utility 会话收尾失败不得伪装成功', () => {
  test('Given 子进程退出未确认 When 自然结束iterator Then 必须保留为专用清理失败', async () => {
    stopFailure = exitUnconfirmed()
    const adapter = new PiUtilityAdapter()
    const drain = new AgentQueryDrain(adapter.query(queryInput), () => adapter.abort('fixture-session'))
    const first = drain.next()
    void first.catch(() => {}) // 先登记拒绝处理，避免 Bun 在评估 rejects 前误报 unhandled。
    await tick()
    endQuery()
    await expect(first).rejects.toBeInstanceOf(AgentQueryDrainError)
    const closing = drain.close()
    void closing.catch(() => {})
    await expect(closing).rejects.toBeInstanceOf(AgentQueryDrainError)
    expect(clientStops.length).toBe(1)
  })

  test('Given 强制停止时退出未确认 When abort Then 拒绝而不是正常收尾', async () => {
    stopFailure = exitUnconfirmed()
    queryAbortCompleted = false
    const adapter = new PiUtilityAdapter()
    const drain = new AgentQueryDrain(adapter.query(queryInput), () => adapter.abort('fixture-session'))
    const pending = drain.next()
    void pending.catch(() => {})
    await tick()
    const aborting = adapter.abort('fixture-session')
    void aborting.catch(() => {})
    await expect(aborting).rejects.toBeInstanceOf(AgentQueryDrainError)
    await pending.catch(() => {})
    const closing = drain.close()
    void closing.catch(() => {})
    await expect(closing).rejects.toBeInstanceOf(AgentQueryDrainError)
  })

  test('Given 正常QUERY_ABORT确认 When abort和自然结束 Then 不误报清理失败', async () => {
    const adapter = new PiUtilityAdapter()
    const drain = new AgentQueryDrain(adapter.query(queryInput), () => adapter.abort('fixture-session'))
    const pending = drain.next()
    await tick()
    await adapter.abort('fixture-session')
    endQuery()
    await pending.catch(() => {})
    await drain.close()
    expect(clientStops.length).toBeGreaterThan(0)
  })
})

describe('来源凭据只在所属query内有效', () => {
  const knowledgeInput = () => ({ ...queryInput, knowledgeMutationObserver: {
    begin: async () => ({ ticketId: 'ticket-1', candidate: true }),
    finish: async () => {},
  } }) as unknown as QueryInput

  test('Given envelope与已注册query不一致 When 提交凭据 Then 拒绝且不触碰观察器', async () => {
    const adapter = new PiUtilityAdapter()
    const drain = new AgentQueryDrain(adapter.query(knowledgeInput()), () => adapter.abort('fixture-session'))
    const pending = drain.next()
    void pending.catch(() => {})
    await tick()
    await expect(adapter.handleRuntimeRequest({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      bootId: 'boot-1',
      kind: 'request',
      method: AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN,
      requestId: 'r1',
      queryId: 'another-query',
      payload: { queryId: currentQueryId, sessionId: 'fixture-session', request: { toolCallId: 't', toolName: 'write', path: '/tmp/x.md' } },
    })).rejects.toThrow('another query')
    endQuery()
    await pending.catch(() => {})
    const closing = drain.close()
    void closing.catch(() => {})
    await closing.catch(() => {})
  })

  test('Given 所属query When 提交凭据 Then 返回候选且finish可送达', async () => {
    const adapter = new PiUtilityAdapter()
    const drain = new AgentQueryDrain(adapter.query(knowledgeInput()), () => adapter.abort('fixture-session'))
    const pending = drain.next()
    void pending.catch(() => {})
    await tick()
    const base = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: 'boot-1', kind: 'request' as const,
      requestId: 'r2', payload: { queryId: currentQueryId, sessionId: 'fixture-session', request: { toolCallId: 't', toolName: 'write', path: '/tmp/x.md' } },
    }
    await expect(adapter.handleRuntimeRequest({ ...base, method: AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN, queryId: currentQueryId }))
      .resolves.toEqual({ ticketId: 'ticket-1', candidate: true })
    await expect(adapter.handleRuntimeRequest({ ...base, requestId: 'r3', method: AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_FINISH, queryId: currentQueryId }))
      .resolves.toEqual({ accepted: true })
    endQuery()
    await pending.catch(() => {})
    const closing = drain.close()
    void closing.catch(() => {})
    await closing
  })
})
