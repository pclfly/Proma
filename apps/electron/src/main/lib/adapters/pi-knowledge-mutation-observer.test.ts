import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createKnowledgeAwareFileTool } from './pi-knowledge-mutation-observer'
import { readKnowledgeWitness } from '../knowledge-witness'
import type { KnowledgeMutationFinish } from '../knowledge-mutation-protocol'

const fixtures = mkdtempSync(join(tmpdir(), 'proma-knowledge-'))
afterAll(() => { rmSync(fixtures, { recursive: true, force: true }) })
const context = { cwd: fixtures } as ExtensionToolContext
const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

function file(name: string, content: string): string {
  const target = join(fixtures, name)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
  return target
}

function observer(candidate = true) {
  const begins: string[] = []
  const finishes: KnowledgeMutationFinish[] = []
  let failFinish = false
  return {
    begins, finishes,
    failFinishWith(value: boolean) { failFinish = value },
    api: {
      async begin(request: { toolCallId: string }) { begins.push(request.toolCallId); return { ticketId: 'ticket-1', candidate } },
      async finish(request: KnowledgeMutationFinish) {
        if (failFinish) throw new Error('fixture finish failure')
        finishes.push(request)
      },
    },
  }
}
const sdk = { createWriteToolDefinition, createEditToolDefinition }

describe('受限文件见证', () => {
  test('Given 普通文件/缺失文件/目录/超大文件 When 读取见证 Then 分类明确且不把错误当缺失', () => {
    const text = file('witness/a.md', '内容')
    expect(readKnowledgeWitness(text).witness).toMatchObject({ state: 'text', byteLength: 6, sha256: sha('内容') })
    const missing = readKnowledgeWitness(join(fixtures, 'witness', 'new.md')).witness
    expect(missing.state).toBe('missing')
    expect(missing.physicalPath.endsWith('new.md')).toBe(true)
    expect(readKnowledgeWitness(join(fixtures, 'witness')).witness.state).toBe('unsupported')
    const large = file('witness/large.md', 'x'.repeat(96 * 1024 + 1))
    expect(readKnowledgeWitness(large).witness.state).toBe('unsupported')
  })
})

describe('受控 write/edit 提交凭据', () => {
  test('Given Write成功 When 执行 Then 只写一次且前后像来自真实文件', async () => {
    const target = file('write/basic.md', '旧内容')
    const fake = observer()
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'write', fake.api)
    await tool.execute('call-write', { path: target, content: '新内容' }, undefined, undefined, context)
    expect(readFileSync(target, 'utf8')).toBe('新内容')
    expect(fake.finishes).toHaveLength(1)
    expect(fake.finishes[0]).toMatchObject({
      ticketId: 'ticket-1', toolCallId: 'call-write', outcome: 'success', writeCount: 1,
      expectedAfterSha256: sha('新内容'), expectedAfterBytes: 9,
    })
    expect(fake.finishes[0]?.preWrite?.sha256).toBe(sha('旧内容'))
    expect(fake.finishes[0]?.observedAfter?.sha256).toBe(sha('新内容'))
  })

  test('Given Edit成功 When 执行 Then SDK真实读入与最终输出都被记录', async () => {
    const target = file('edit/basic.md', 'OLD\nkeep\n')
    const fake = observer()
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'edit', fake.api)
    await tool.execute('call-edit', { path: target, edits: [{ oldText: 'OLD', newText: 'NEW' }] }, undefined, undefined, context)
    expect(readFileSync(target, 'utf8')).toBe('NEW\nkeep\n')
    expect(fake.finishes[0]).toMatchObject({ outcome: 'success', writeCount: 1, expectedAfterSha256: sha('NEW\nkeep\n') })
    expect(fake.finishes[0]?.sdkRead?.sha256).toBe(sha('OLD\nkeep\n'))
  })

  test('Given Edit找不到旧文本 When SDK拒绝 Then 不产生成功凭据也不写文件', async () => {
    const target = file('edit/missing.md', 'keep\n')
    const fake = observer()
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'edit', fake.api)
    await expect(tool.execute('call-missing', { path: target, edits: [{ oldText: 'NOPE', newText: 'x' }] }, undefined, undefined, context)).rejects.toThrow('Could not find')
    expect(readFileSync(target, 'utf8')).toBe('keep\n')
    expect(fake.finishes.map(item => item.outcome)).toEqual(['failed'])
  })

  test('Given 调用前已取消 When 执行 Then 只提交aborted且保持业务错误', async () => {
    const target = file('abort/basic.md', '旧内容')
    const fake = observer()
    const controller = new AbortController()
    controller.abort()
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'write', fake.api)
    await expect(tool.execute('call-abort', { path: target, content: '不应写入' }, controller.signal, undefined, context)).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('旧内容')
    expect(fake.finishes.every(item => item.outcome !== 'success')).toBe(true)
  })

  test('Given 观察器登记失败 When 工具执行 Then 原写入照常成功且不产出凭据', async () => {
    const target = file('degrade/begin.md', '旧内容')
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'write', {
      begin: async () => { throw new Error('观测失败') },
      finish: async () => { throw new Error('不应调用') },
    })
    await tool.execute('call-degrade', { path: target, content: '新内容' }, undefined, undefined, context)
    expect(readFileSync(target, 'utf8')).toBe('新内容')
  })

  test('Given 提交凭据失败 When 工具成功 Then 仍返回原结果且文件只写一次', async () => {
    const target = file('degrade/finish.md', '旧内容')
    const fake = observer()
    fake.failFinishWith(true)
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'write', fake.api)
    const result = await tool.execute('call-finish', { path: target, content: '新内容' }, undefined, undefined, context)
    expect(result).toBeDefined()
    expect(readFileSync(target, 'utf8')).toBe('新内容')
  })

  test('Given 不是候选目标 When 写入 Then 不替换SDK操作也不登记成功凭据', async () => {
    const target = file('notcandidate/basic.md', '旧内容')
    const fake = observer(false)
    const tool = createKnowledgeAwareFileTool(sdk, fixtures, 'write', fake.api)
    await tool.execute('call-none', { path: target, content: '新内容' }, undefined, undefined, context)
    expect(readFileSync(target, 'utf8')).toBe('新内容')
    expect(fake.finishes).toEqual([])
  })
})
