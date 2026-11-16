import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { AttributedKnowledgeChange } from '@proma/shared'
import { createKnowledgeChangeDiff, WorkspaceKnowledgeMutationBroker } from './workspace-knowledge-mutation-broker'
import type { KnowledgeMutationScope, KnowledgeMutationSnapshot } from './workspace-knowledge-mutation-broker'
import type { KnowledgeMutationFinish, KnowledgeMutationTicket } from './knowledge-mutation-protocol'

function snapshot(text: string | undefined, version = 'v1'): KnowledgeMutationSnapshot {
  return text === undefined ? { witness: { state: 'missing', physicalPath: '/memory/a.md' } } : {
    text, witness: { state: 'text', physicalPath: '/memory/a.md', version,
      byteLength: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') },
  }
}
function scope(sessionId: string): KnowledgeMutationScope {
  return { sessionId, runGeneration: 1, queryId: `query-${sessionId}`, workspaceId: `workspace-${sessionId}`, workspaceSlug: `slug-${sessionId}` }
}
function receipt(ticket: KnowledgeMutationTicket, before: KnowledgeMutationSnapshot, after: KnowledgeMutationSnapshot): KnowledgeMutationFinish {
  return { ticketId: ticket.ticketId, toolCallId: 'tool', outcome: 'success', writeCount: 1,
    sdkRead: before.witness, preWrite: before.witness, observedAfter: after.witness,
    expectedAfterBytes: after.witness.byteLength, expectedAfterSha256: after.witness.sha256 }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function harness(maxTickets = 128) {
  let current = snapshot('原文')
  let boundary = 'root:parent'
  let allowed = true
  let eligible = true
  let readWait: Promise<void> | undefined
  const live = new Set(['A', 'B', 'C'])
  const events: AttributedKnowledgeChange[] = []
  const broker = new WorkspaceKnowledgeMutationBroker({
    maxTickets,
    resolveTarget: (_owner, path) => ({ key: '/memory/a.md', logicalPath: path, boundaryIdentity: boundary,
      ...(allowed && eligible ? { file: { kind: 'memory' as const, relativePath: 'a.md' } } : {}) }),
    read: async () => { const value = current; await readWait; return value },
    isCurrent: owner => live.has(owner.sessionId),
    emit: change => { events.push(change) },
  })
  return { broker, events, live, before: current,
    setText(text: string | undefined, version = 'v2') { current = snapshot(text, version); return current },
    setBoundary(value: string) { boundary = value },
    revoke() { allowed = false },
    setEligible(value: boolean) { eligible = value },
    waitOnRead(value: Promise<void> | undefined) { readWait = value },
    bind: (id: string) => broker.bind(scope(id)),
  }
}
const begin = { toolCallId: 'tool', toolName: 'write' as const, path: '/logical/a.md' }

describe('可信知识变更提交凭据', () => {
  test('Given 成功的单次受控Write When 前后像均核验 Then 只发给明确来源且凭据不能重放', async () => {
    const h = harness(), a = h.bind('A'), b = h.bind('B')
    const ticket = (await a.begin(begin))!
    const after = h.setText('新文')
    const finished = receipt(ticket, h.before, after)
    await b.finish(finished) // 其他 query 无权消费 A 的 ticket。
    expect(h.events).toEqual([])
    await a.finish(finished)
    await a.finish(finished)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]?.source).toEqual({ sessionId: 'A', runGeneration: 1, queryId: 'query-A', toolCallId: 'tool', toolName: 'write' })
    expect(h.events[0]?.workspaceId).toBe('workspace-A')
    expect(h.events[0]?.diff).toMatchObject({ removed: ['原文'], added: ['新文'] })
  })

  test('Given 两会话/工作区别名写同一物理目标 When 重叠提交 Then 两者均不能归因', async () => {
    const h = harness(), a = h.bind('A'), b = h.bind('B')
    const ta = (await a.begin(begin))!
    const tb = (await b.begin({ ...begin, path: '/alias/a.md' }))!
    expect(tb.candidate).toBe(false)
    const after = h.setText('重叠写')
    await b.finish(receipt(tb, h.before, after))
    await a.finish(receipt(ta, h.before, after))
    expect(h.events).toEqual([])
  })

  test('Given 外部scope无展示资格的writer已开始 When 另一个来源开始 Then 仍检测全局竞争', async () => {
    const h = harness(), a = h.bind('A'), b = h.bind('B')
    h.setEligible(false)
    const tb = (await b.begin(begin))!
    expect(tb.candidate).toBe(false)
    h.setEligible(true)
    const ta = (await a.begin(begin))!
    expect(ta.candidate).toBe(false)
    const after = h.setText('新文')
    await a.finish(receipt(ta, h.before, after)); await b.finish(receipt(tb, h.before, after))
    expect(h.events).toEqual([])
  })

  test('Given 两次顺序写入 When 分别成功 Then 第二次diff只含自己的前后像', async () => {
    const h = harness(), a = h.bind('A'), b = h.bind('B')
    const ta = (await a.begin(begin))!, mid = h.setText('中间版本')
    await a.finish(receipt(ta, h.before, mid))
    const tb = (await b.begin(begin))!, end = h.setText('最终版本', 'v3')
    await b.finish(receipt(tb, mid, end))
    expect(h.events).toHaveLength(2)
    expect(h.events[1]?.diff.removed).toEqual(['中间版本'])
    expect(h.events[0]?.changeId).not.toBe(h.events[1]?.changeId)
  })

  for (const cause of ['failed', 'aborted', 'multi-write', 'read-drift', 'pre-write-drift', 'post-drift', 'wrong-output', 'no-op', 'permission', 'path', 'stop', 'manual'] as const) {
    test(`Given ${cause} When 完成提交核验 Then 不补猜来源`, async () => {
      const h = harness(), a = h.bind('A')
      const ticket = (await a.begin({ ...begin, toolName: 'edit' }))!
      const after = h.setText(cause === 'no-op' ? '原文' : '新文')
      const finish = receipt(ticket, h.before, after)
      if (cause === 'failed' || cause === 'aborted') finish.outcome = cause
      if (cause === 'multi-write') finish.writeCount = 2
      if (cause === 'read-drift') finish.sdkRead = snapshot('不同读入').witness
      if (cause === 'pre-write-drift') finish.preWrite = snapshot('别人改过').witness
      if (cause === 'post-drift') h.setText('工具之后外部改写', 'v3')
      if (cause === 'wrong-output') finish.expectedAfterSha256 = '0'.repeat(64)
      if (cause === 'permission') h.revoke()
      if (cause === 'path') h.setBoundary('different-parent')
      if (cause === 'stop') h.live.delete('A')
      if (cause === 'manual') h.broker.invalidateTarget('/memory/a.md')
      await a.finish(finish)
      expect(h.events).toEqual([])
    })
  }

  for (const cause of ['overlap', 'stop', 'close', 'abort'] as const) {
    test(`Given finish正在读取后像 When ${cause}在await期间发生 Then emit前二次核验拒绝`, async () => {
      const h = harness(), a = h.bind('A'), b = h.bind('B'), gate = deferred()
      const ticket = (await a.begin(begin))!, after = h.setText('新文')
      h.waitOnRead(gate.promise)
      const controller = new AbortController()
      const finishing = a.finish(receipt(ticket, h.before, after), controller.signal)
      h.waitOnRead(undefined)
      if (cause === 'overlap') await b.begin(begin)
      if (cause === 'stop') h.live.delete('A')
      if (cause === 'close') a.close()
      if (cause === 'abort') controller.abort()
      gate.resolve(); await finishing
      expect(h.events).toEqual([])
      a.close(); b.close()
    })
  }

  test('Given 容量满且未知writer未关闭 When 旧ticket结束又开始 Then 不因腾出容量恢复归因', async () => {
    const h = harness(1), a = h.bind('A'), b = h.bind('B')
    const ta = (await a.begin(begin))!
    expect(await b.begin(begin)).toBeNull()
    const after = h.setText('新文')
    await a.finish(receipt(ta, h.before, after))
    expect(h.events).toEqual([])
    expect((await a.begin(begin))?.candidate).toBe(false)
    a.close(); b.close()
    const c = h.bind('C')
    expect((await c.begin(begin))?.candidate).toBe(true)
    c.close()
  })

  test('Given 缺失文件 When 单次创建成功 Then 标为创建且不捏造旧正文', async () => {
    const h = harness(), a = h.bind('A')
    const before = h.setText(undefined)
    const ticket = (await a.begin(begin))!, after = h.setText('创建内容')
    await a.finish(receipt(ticket, before, after))
    expect(h.events[0]?.kind).toBe('created')
    expect(h.events[0]?.diff.added).toEqual(['创建内容'])
  })

  test('Given 超长正文或长单行 When 生成展示 Then 正文候选受限且diff行/字符有界', async () => {
    const h = harness(), a = h.bind('A')
    h.setText('a'.repeat(96 * 1024 + 1))
    expect((await a.begin(begin))?.candidate).toBe(false)
    a.close()
    const diff = createKnowledgeChangeDiff('旧文', Array.from({ length: 10 }, () => '新'.repeat(1000)).join('\n'))
    expect(diff.added).toHaveLength(8)
    expect(diff.added.every(line => line.length === 256)).toBe(true)
    expect(diff.truncated).toBe(true)
  })
})
