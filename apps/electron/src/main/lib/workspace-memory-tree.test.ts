import { afterAll, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMemoryFileNode } from '@proma/shared'

const actual = { ...fs }
let inspected = 0, opened = 0, closed = 0
mock.module('node:fs', () => ({ ...actual, opendirSync: (path: string, options?: { bufferSize?: number }) => {
  const stream = actual.opendirSync(path, options); opened += 1
  return { readSync: () => { inspected += 1; return stream.readSync() }, closeSync: () => { closed += 1; stream.closeSync() } }
} }))
const { scanWorkspaceMemoryTree } = await import('./workspace-memory-tree')
const temporary = actual.mkdtempSync(join(tmpdir(), 'proma-memory-stream-'))
const anchor = actual.realpathSync(temporary), memory = join(anchor, 'memory')
actual.mkdirSync(memory)
afterAll(() => { actual.rmSync(temporary, { recursive: true, force: true }) })
const policy = { anchor, logicalRoot: memory, authorizedDirectories: [] }
function resetCounts(): void { inspected = 0; opened = 0; closed = 0 }
function find(nodes: WorkspaceMemoryFileNode[], path: string): WorkspaceMemoryFileNode | undefined { for (const node of nodes) { if (node.relativePath === path) return node; const nested = find(node.children ?? [], path); if (nested) return nested } return undefined }

test('Given 大目录 When maxNodes=1或零预算 Then 可提前停止目录流且全部关闭', () => {
  for (let index = 0; index < 2048; index += 1) actual.writeFileSync(join(memory, `${index}.md`), '')
  resetCounts()
  const tree = scanWorkspaceMemoryTree(policy, { maxNodes: 1, inspectText: false })
  expect(tree.nodes).toHaveLength(1)
  expect(tree.truncated).toBe(true)
  expect(inspected).toBe(1)
  expect(opened).toBe(closed)
  resetCounts()
  expect(scanWorkspaceMemoryTree(policy, { maxNodes: 0 }).truncated).toBe(true)
  expect(opened).toBe(0)
})

test('Given 隐藏项和普通项 When maxEntries=1 Then 隐藏项也消耗枚举预算', () => {
  actual.writeFileSync(join(memory, '.hidden'), 'hidden')
  resetCounts()
  expect(scanWorkspaceMemoryTree(policy, { maxEntries: 1 }).truncated).toBe(true)
  expect(inspected).toBe(1)
  expect(opened).toBe(closed)
})

test('Given 目录链接回到祖先 When 检测循环 Then 保留directory类型且合法别名分别可见', () => {
  const external = join(anchor, 'external')
  actual.mkdirSync(external); actual.writeFileSync(join(external, 'a.md'), 'content')
  const link = (target: string, path: string): void => { actual.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir') }
  link(external, join(external, 'back'))
  const cleanMemory = join(anchor, 'linked-memory'); actual.mkdirSync(cleanMemory)
  link(external, join(cleanMemory, 'first')); link(external, join(cleanMemory, 'second'))
  const tree = scanWorkspaceMemoryTree({ anchor, logicalRoot: cleanMemory, authorizedDirectories: [actual.realpathSync(external)] })
  expect(find(tree.nodes, 'first/back')).toMatchObject({ type: 'directory', children: [], linkState: 'cycle' })
  expect(find(tree.nodes, 'first/a.md')?.isText).toBe(true)
  expect(find(tree.nodes, 'second/a.md')?.isText).toBe(true)
})
