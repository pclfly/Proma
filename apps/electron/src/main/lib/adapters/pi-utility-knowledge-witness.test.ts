import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_RUNTIME_METHODS, AGENT_RUNTIME_PROTOCOL_VERSION } from '@proma/shared'
import type { AgentRuntimeRequest, AttributedKnowledgeChange } from '@proma/shared'
import { createWriteToolDefinition, createEditToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { WorkspaceKnowledgeMutationBroker } from '../workspace-knowledge-mutation-broker'
import type { KnowledgeMutationTarget } from '../workspace-knowledge-mutation-broker'
import { readKnowledgeWitness } from '../knowledge-witness'
import { createKnowledgeAwareFileTool } from './pi-knowledge-mutation-observer'
import { createKnowledgeMutationProxy } from '../../../utility/knowledge-mutation-proxy'
import { AgentQueryDrain } from '../agent-query-drain'
import { rmSyncWithRetry } from '../fs-retry'

let requestHandler: ((request: AgentRuntimeRequest) => Promise<unknown>) | undefined
let listener: ((event: unknown) => void) | undefined
let activeQueryId = ''
mock.module('../agent-runtime-client', () => ({
  AgentRuntimeClient: class {
    setRequestHandler(handler: (request: AgentRuntimeRequest) => Promise<unknown>): void { requestHandler = handler }
    onEvent(next: (event: unknown) => void): () => void { listener = next; return () => { listener = undefined } }
    async call(method: string, payload?: { queryId?: string }): Promise<unknown> {
      if (method === AGENT_RUNTIME_METHODS.QUERY_START) activeQueryId = payload?.queryId ?? ''
      return { completed: true }
    }
    async stop(): Promise<void> {}
  },
}))
const { PiUtilityAdapter } = await import('./pi-utility-adapter')
const sdk = { createWriteToolDefinition, createEditToolDefinition }
const context = { cwd: '', hasUI: false } as ExtensionToolContext
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 模拟structured-clone传输，保留真实proxy/adapter/broker/SDK文件操作；不是原生MessagePort或Electron进程。 */
async function harness(run: (value: {
  root: string; alias: string; real: string; proxy: ReturnType<typeof createKnowledgeMutationProxy>;
  changes: AttributedKnowledgeChange[]; methods: string[]; revoke: () => void;
  send: (method: string, request: unknown, queryId?: string) => Promise<unknown>;
  pauseNextRead: () => { started: Promise<void>; release: () => void };
  cancelLastRequest: () => Promise<unknown>;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proma-witness-rpc-'))
  mkdirSync(join(root, 'memory')); mkdirSync(join(root, 'external'))
  const real = join(root, 'external', 'a.md'), alias = join(root, 'memory', 'linked.md')
  writeFileSync(real, 'OLD\nkeep\n'); symlinkSync(real, alias, 'file')
  let allowed = true
  const changes: AttributedKnowledgeChange[] = []
  const target: KnowledgeMutationTarget = { key: real, physicalPath: real, logicalPath: alias, boundaryIdentity: 'synthetic-authorized-boundary', file: { kind: 'memory', relativePath: 'linked.md' } }
  let nextReadGate: { wait: Promise<void>; started: () => void } | undefined
  const pauseNextRead = (): { started: Promise<void>; release: () => void } => {
    let release: () => void = () => { throw new Error('尚未初始化') }
    let notify: () => void = () => { throw new Error('尚未初始化') }
    const wait = new Promise<void>((done) => { release = done })
    const started = new Promise<void>((done) => { notify = done })
    nextReadGate = { wait, started: notify }
    return { started, release }
  }
  const broker = new WorkspaceKnowledgeMutationBroker({
    resolveTarget: (_scope, path) => allowed && path === alias ? target : undefined,
    read: async current => {
      const gate = nextReadGate
      nextReadGate = undefined
      if (gate) { gate.started(); await gate.wait }
      return readKnowledgeWitness(current.physicalPath ?? current.logicalPath)
    },
    isCurrent: () => true, emit: change => changes.push(change),
  })
  const observer = broker.bind({ sessionId: 'fixture-session', runGeneration: 1, queryId: 'broker-query', workspaceId: 'fixture-workspace', workspaceSlug: 'fixture' })
  const adapter = new PiUtilityAdapter()
  const input = { sessionId: 'fixture-session', knowledgeMutationObserver: observer } as unknown as import('./pi-agent-adapter').PiAgentQueryOptions
  const drain = new AgentQueryDrain(adapter.query(input), () => adapter.abort('fixture-session'))
  const pending = drain.next(); void pending.catch(() => {})
  const methods: string[] = []
  let sequence = 0
  try {
    for (let tries = 0; !activeQueryId && tries < 20; tries += 1) await tick()
    if (!requestHandler || !activeQueryId) throw new Error('合成runtime未启动')
    const send = async (method: string, request: unknown, queryId = activeQueryId): Promise<unknown> => {
      methods.push(method)
      const message: AgentRuntimeRequest = { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: 'fixture-boot', kind: 'request', requestId: String(++sequence), method, queryId, sessionId: 'fixture-session', payload: { queryId, sessionId: 'fixture-session', request: structuredClone(request) } }
      return structuredClone(await requestHandler!(message))
    }
    const proxy = createKnowledgeMutationProxy((method, request) => send(method, request))
    const cancelLastRequest = async (): Promise<unknown> => {
      const canceledId = String(sequence)
      return requestHandler!({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: 'fixture-boot', kind: 'request',
        requestId: `cancel-${++sequence}`, method: AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL, queryId: activeQueryId,
        sessionId: 'fixture-session', payload: { requestId: canceledId, queryId: activeQueryId } })
    }
    await run({ root, alias, real, proxy, changes, methods, revoke: () => { allowed = false }, send, pauseNextRead, cancelLastRequest })
  } finally {
    listener?.({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: 'fixture-boot', kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END, queryId: activeQueryId, payload: {} })
    await pending.catch(() => {}); await drain.close().catch(() => {}); observer.close()
    activeQueryId = ''; requestHandler = undefined; listener = undefined
    rmSyncWithRetry(root, { recursive: true, force: true })
  }
}

describe('utility知识见证RPC闭包', () => {
  for (const phase of ['begin', 'witness', 'finish'] as const) test(`Given ${phase}正在main等待 When 同源CANCEL Then 不返回迟到见证或发归因`, async () => {
    await harness(async value => {
      const begin = { toolCallId: 'canceled-call', toolName: 'write' as const, path: value.alias }
      const ticket = phase === 'begin' ? null : await value.proxy.begin(begin)
      const request = { ticketId: ticket?.ticketId ?? '', toolCallId: begin.toolCallId, path: value.alias }
      const before = phase === 'finish' ? await value.proxy.readWitness?.(request) : undefined
      if (phase === 'finish') writeFileSync(value.real, 'NEW\nkeep\n')
      const after = phase === 'finish' ? await value.proxy.readWitness?.(request) : undefined
      const gate = value.pauseNextRead()
      const result = phase === 'begin' ? value.proxy.begin(begin)
        : phase === 'witness' ? value.proxy.readWitness!(request)
          : value.proxy.finish({ ticketId: ticket!.ticketId, toolCallId: begin.toolCallId, outcome: 'success', writeCount: 1,
            preWrite: before, observedAfter: after, expectedAfterSha256: after?.sha256, expectedAfterBytes: after?.byteLength })
      await gate.started
      await value.cancelLastRequest()
      gate.release()
      const reply = await result
      expect(reply).toBe(phase === 'begin' ? null : undefined)
      expect(value.changes).toEqual([])
      expect(readFileSync(value.real, 'utf8')).toBe(phase === 'finish' ? 'NEW\nkeep\n' : 'OLD\nkeep\n')
    })
  })

  for (const kind of ['write', 'edit'] as const) test(`Given 已授权最终文件链接 When ${kind}经proxy/adapter/broker Then 保留链接并归因真实SDK提交`, async () => {
    await harness(async value => {
      const tool = createKnowledgeAwareFileTool(sdk, value.root, kind, value.proxy)
      const input = kind === 'write' ? { path: value.alias, content: 'NEW\nkeep\n' } : { path: value.alias, edits: [{ oldText: 'OLD', newText: 'NEW' }] }
      await tool.execute('typed-call', input, undefined, undefined, context)
      expect(readFileSync(value.real, 'utf8')).toBe('NEW\nkeep\n')
      expect(value.changes).toHaveLength(1)
      expect(value.changes[0]?.file).toEqual({ kind: 'memory', relativePath: 'linked.md' })
      expect(value.methods.filter(method => method === AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_WITNESS)).toHaveLength(kind === 'write' ? 2 : 3)
    })
  })

  test('Given 伪造票据/另一工具/撤销授权 When 请求见证 Then 不返回正文或见证', async () => {
    await harness(async value => {
      const ticket = await value.proxy.begin({ toolCallId: 'call', toolName: 'write', path: value.alias })
      expect(ticket?.candidate).toBe(true)
      const request = { ticketId: ticket!.ticketId, toolCallId: 'call', path: value.alias }
      expect((await value.proxy.readWitness?.(request))?.state).toBe('text')
      expect(await value.proxy.readWitness?.({ ...request, ticketId: 'forged' })).toBeUndefined()
      expect(await value.proxy.readWitness?.({ ...request, toolCallId: 'another' })).toBeUndefined()
      value.revoke()
      expect(await value.proxy.readWitness?.(request)).toBeUndefined()
    })
  })

  test('Given 另一query的请求 When 经真实注册的handler Then 传输归属先拒绝', async () => {
    await harness(async value => {
      await expect(value.send(AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_WITNESS, { ticketId: 'fake', toolCallId: 'call', path: value.alias }, 'another-query')).rejects.toThrow('another query transport')
      expect(value.changes).toEqual([])
    })
  })

  test('Given 见证await期间取消 When SDK继续执行 Then 不写文件或伪造成功来源', async () => {
    await harness(async value => {
      const controller = new AbortController()
      const proxy = { ...value.proxy, readWitness: async () => { controller.abort(); await tick(); return undefined } }
      const tool = createKnowledgeAwareFileTool(sdk, value.root, 'write', proxy)
      await expect(tool.execute('abort-call', { path: value.alias, content: 'SHOULD NOT WRITE' }, controller.signal, undefined, context)).rejects.toThrow()
      expect(readFileSync(value.real, 'utf8')).toBe('OLD\nkeep\n')
      expect(value.changes).toEqual([])
    })
  })
})
