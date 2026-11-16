import { describe, expect, test } from 'bun:test'
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolvePiToolPath } from './pi-tool-path'
import { restorePiInput, normalizePermissionInput } from './pi-message-adapter'
import { wrapToolWithPermission } from './pi-tool-permission'
import { validateToolInput } from '../agent-tool-input-validator'

// 内存工具只读取cwd；其余extension能力在该测试中不会调用。
const context = { cwd: process.cwd() } as ExtensionToolContext

function fixture() {
  let content = 'OLD\nkeep\n'
  let writes = 0, permissions = 0
  const edit = wrapToolWithPermission(createEditToolDefinition(process.cwd(), { operations: {
    access: async () => {}, readFile: async () => Buffer.from(content),
    writeFile: async (_path, next) => { writes++; content = next },
  } }), { canUseTool: async (name, input) => {
    permissions++
    return validateToolInput(name, input) ?? { behavior: 'allow', updatedInput: input }
  } })
  return { edit, get: () => ({ content, writes, permissions }) }
}

describe('真实Pi定义→权限包装→内存文件操作', () => {
  test('Given 删除匹配文本 When 经过权限层执行 Then 写入空替换结果', async () => {
    const f = fixture()
    await f.edit.execute('one', { path: 'fixture.ts', edits: [{ oldText: 'OLD', newText: '' }] }, undefined, undefined, context)
    expect(f.get()).toEqual({ content: '\nkeep\n', writes: 1, permissions: 1 })
  })
  test('Given 第二项空锚点 When 校验 Then 在权限与写入前按原生索引拒绝', async () => {
    const f = fixture()
    await expect(f.edit.execute('bad', { path: 'fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }, { oldText: '', newText: 'x' }] }, undefined, undefined, context)).rejects.toThrow('edits[1].oldText')
    expect(f.get().writes).toBe(0)
    expect(f.get().permissions).toBe(0)
  })
  test('Given 找不到旧文本 When 通过输入校验 Then 仍由SDK安全拒绝而非整文件覆盖', async () => {
    const f = fixture()
    await expect(f.edit.execute('missing', { path: 'fixture.ts', edits: [{ oldText: 'NOT FOUND', newText: 'NEW' }] }, undefined, undefined, context)).rejects.toThrow('Could not find')
    expect(f.get().writes).toBe(0)
  })
  test('Given SDK特殊路径 When 规范化 Then 权限路径与实际SDK写入相同', async () => {
    const actual: string[] = []
    const tool = createWriteToolDefinition(process.cwd(), { operations: { mkdir: async () => {}, writeFile: async (path) => { actual.push(path) } } })
    const inputs = ['@nested/file.txt', 'nested/a\u00a0b.txt', '~/fixture.txt', pathToFileURL(resolve('nested/file.txt')).href, ...(process.platform === 'win32' ? ['/d/fixture.txt', '/mnt/d/fixture.txt', '/cygdrive/d/fixture.txt'] : [])]
    for (const path of inputs) {
      await tool.execute('path', { path, content: '' }, undefined, undefined, context)
      expect(actual.at(-1)).toBe(resolvePiToolPath(path, process.cwd()))
    }
  })
  test('Given 权限改动执行路径 When 包装执行 Then 拒绝并要求新调用重新检查作用域', async () => {
    let writes = 0
    const tool = wrapToolWithPermission(createWriteToolDefinition(process.cwd(), { operations: { mkdir: async () => {}, writeFile: async () => { writes++ } } }), {
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: { ...input, file_path: 'nested/file.txt' } }),
    })
    await expect(tool.execute('changed', { path: 'safe.txt', content: '' }, undefined, undefined, context)).rejects.toThrow('修改了工具目标路径')
    expect(writes).toBe(0)
  })
  test('Given 权限修改单项兼容别名 When 执行 Then 使用实际批准文本，冲突不静默选择', async () => {
    let content = 'OLD'
    const tool = wrapToolWithPermission(createEditToolDefinition(process.cwd(), { operations: { access: async () => {}, readFile: async () => Buffer.from(content), writeFile: async (_path, next) => { content = next } } }), {
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: { ...input, new_string: 'APPROVED' } }),
    })
    await tool.execute('approved', { path: 'fixture.txt', edits: [{ oldText: 'OLD', newText: 'ORIGINAL' }] }, undefined, undefined, context)
    expect(content).toBe('APPROVED')
    const original = { path: 'fixture.txt', edits: [{ oldText: 'OLD', newText: 'ORIGINAL' }] }
    expect(() => restorePiInput('edit', original, { new_string: 'A', edits: [{ oldText: 'OLD', newText: 'B' }] })).toThrow('冲突')
    const multi = { path: 'fixture.txt', edits: [{ oldText: 'A', newText: 'a' }, { oldText: 'B', newText: 'b' }] }
    const normalized = normalizePermissionInput('edit', multi)
    const edits = normalized.edits as Record<string, unknown>[]
    edits[1]!.new_string = ''
    expect(restorePiInput('edit', multi, normalized).edits).toEqual([{ oldText: 'A', newText: 'a' }, { oldText: 'B', newText: '' }])
  })
  test('Given 空content When 写入新文件 Then 允许空文件且不触碰真实磁盘', async () => {
    const writes: string[] = []
    const tool = wrapToolWithPermission(createWriteToolDefinition(process.cwd(), { operations: {
      mkdir: async () => {}, writeFile: async (_path, content) => { writes.push(content) },
    } }), { canUseTool: async (name, input) => validateToolInput(name, input) ?? { behavior: 'allow' } })
    await tool.execute('empty', { path: 'empty-fixture.txt', content: '' }, undefined, undefined, context)
    expect(writes).toEqual([''])
  })
})
