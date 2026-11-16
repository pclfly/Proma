import { describe, expect, test } from 'bun:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { SAFE_TOOLS } from '@proma/shared'
import { createAgentContextRequestPolicy } from '../agent-context-request-policy'
import { buildReadContextTool, getRecoverableContextMessages } from './pi-context-tool'

const cwd = process.cwd()
const context = { cwd } as ExtensionToolContext
function fixture() {
  const manager = sdk.SessionManager.inMemory(cwd)
  const root = manager.appendMessage({ role: 'user', content: '读取旧文件', timestamp: 1 })
  const original = 'OLD SNAPSHOT\n'.repeat(1800)
  const target = manager.appendMessage({ role: 'toolResult', toolCallId: 'read-one', toolName: 'read', content: [{ type: 'text', text: original }], isError: false, timestamp: 2 })
  manager.appendMessage({ role: 'user', content: '新任务：只需要原文一个片段', timestamp: 3 })
  const source = () => getRecoverableContextMessages(manager.getBranch())
  const policy = createAgentContextRequestPolicy({ getSourceMessages: source })
  const ref = JSON.stringify(policy.project(source())).match(/ctx_[a-f0-9]{64}/)![0]
  return { manager, root, target, original, policy, source, ref }
}

describe('ReadContext原生分支与权限边界', () => {
  test('Given 原始Pi记录 When 按引用读取 Then 只返回选定范围和nextOffset，原始条目不变', async () => {
    const f = fixture(), before = JSON.stringify(f.manager.getEntries())
    const tool = buildReadContextTool(sdk, f.policy)
    const result = await tool.execute('fetch', { reference: f.ref, offset: 15, limit: 35 }, undefined, undefined, context)
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('缺少片段')
    expect(block.text).toContain(f.original.slice(15, 50))
    expect(JSON.parse(block.text.split('\n')[0]!).nextOffset).toBe(50)
    expect(JSON.stringify(f.manager.getEntries())).toBe(before)
    expect(SAFE_TOOLS).toContain('ReadContext')
  })

  test('Given 原生压缩与新policy实例 When 原文已离开模型上下文 Then 同分支仍可取回旧快照', () => {
    const f = fixture()
    const kept = f.manager.getLeafId()!
    f.manager.appendCompaction('完成了旧文件检查，材料按引用读取。', kept, 10000)
    expect(f.manager.buildSessionProjection().messages.some((message) => JSON.stringify(message).includes('OLD SNAPSHOT'))).toBe(false)
    const restored = createAgentContextRequestPolicy({ getSourceMessages: f.source })
    expect(restored.read(f.ref, { limit: 12 }).text).toBe('OLD SNAPSHOT')
  })

  test('Given rewind切换branch When 再读旧ref Then 原文不能从全文件或旧缓存泄露', () => {
    const f = fixture()
    expect(f.policy.read(f.ref, { limit: 12 }).text).toBe('OLD SNAPSHOT')
    f.manager.branch(f.root)
    expect(() => f.policy.read(f.ref)).toThrow('当前分支')
    expect(f.manager.getEntries().some((entry) => entry.id === f.target)).toBe(true)
  })

  test('Given 显式context_edit删除或替换 When 读旧引用 Then 不复活已隐藏原文', () => {
    const f = fixture()
    f.manager.appendContextEdit(f.target, { content: [{ type: 'text', text: 'REDACTED' }] })
    expect(() => f.policy.read(f.ref)).toThrow('当前分支')
    expect(f.source().some((message) => JSON.stringify(message.content).includes('REDACTED'))).toBe(true)
    f.manager.appendContextEdit(f.target, null)
    expect(f.source().some((message) => message.toolCallId === 'read-one')).toBe(false)
    expect(() => f.policy.read(f.ref)).toThrow('当前分支')
  })

  test('Given 两个独立原生会话 When 交叉使用ref Then 不读取另一会话材料', () => {
    const f = fixture()
    const other = sdk.SessionManager.inMemory(cwd)
    other.appendMessage({ role: 'user', content: 'other session', timestamp: 1 })
    const policy = createAgentContextRequestPolicy({ getSourceMessages: () => getRecoverableContextMessages(other.getBranch()) })
    expect(() => policy.read(f.ref)).toThrow('当前分支')
  })

  test('Given 权限拒绝或中止 When 执行 Then 不返回原文，不调用其他工具', async () => {
    const f = fixture()
    const denied = buildReadContextTool(sdk, f.policy, async (name) => {
      expect(name).toBe('ReadContext')
      return { behavior: 'deny', message: '禁止读取' }
    })
    await expect(denied.execute('denied', { reference: f.ref }, undefined, undefined, context)).rejects.toThrow('禁止读取')
    const abort = new AbortController(); abort.abort()
    const tool = buildReadContextTool(sdk, f.policy)
    await expect(tool.execute('aborted', { reference: f.ref }, abort.signal, undefined, context)).rejects.toThrow('取消')
  })

  test('Given 大量转义字符 When 工具返回8000字符 Then 不因JSON转义膨胀而立即再次截断', async () => {
    const manager = sdk.SessionManager.inMemory(cwd)
    manager.appendMessage({ role: 'user', content: 'old', timestamp: 1 })
    const body = '\n"\\'.repeat(5000)
    manager.appendMessage({ role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: body }], isError: false, timestamp: 2 })
    manager.appendMessage({ role: 'user', content: 'fetch', timestamp: 3 })
    const source = () => getRecoverableContextMessages(manager.getBranch())
    const policy = createAgentContextRequestPolicy({ getSourceMessages: source })
    const ref = JSON.stringify(policy.project(source())).match(/ctx_[a-f0-9]{64}/)![0]
    const result = await buildReadContextTool(sdk, policy).execute('fetch', { reference: ref, limit: 8000 }, undefined, undefined, context)
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('缺少文本')
    expect(block.text.length).toBeLessThan(8500)
    const message = { role: 'toolResult', toolCallId: 'fetch', toolName: 'ReadContext', content: result.content, isError: false }
    expect(policy.project([...source(), message]).at(-1)).toBe(message)
  })
})

describe('压缩后材料重新发现', () => {
  test('Given 新policy完全不知道带外旧ref When 通过工具查索引 Then 可发现并读取压缩前原文，删除后索引也失效', async () => {
    const f = fixture()
    f.manager.appendCompaction('完成旧任务。当前没有保留任何原文引用。', f.manager.getLeafId()!, 10000)
    const policy = createAgentContextRequestPolicy({ getSourceMessages: f.source })
    const tool = buildReadContextTool(sdk, policy)
    const indexResult = await tool.execute('index', {}, undefined, undefined, context)
    const first = indexResult.content[0]
    if (first?.type !== 'text') throw new Error('没有索引')
    const index = JSON.parse(first.text) as { materials: Array<{ reference: string }> }
    expect(index.materials).toHaveLength(1)
    const discovered = index.materials[0]!.reference
    expect(policy.read(discovered, { limit: 12 }).text).toBe('OLD SNAPSHOT')
    f.manager.appendContextEdit(f.target, null)
    expect(policy.list().materials).toHaveLength(0)
    expect(() => policy.read(discovered)).toThrow('当前分支')
  })
})
