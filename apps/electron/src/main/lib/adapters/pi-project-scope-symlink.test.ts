import { describe, expect, mock, test } from 'bun:test'
import { resolve, dirname } from 'node:path'
import * as actualFs from 'node:fs'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

const root = resolve('synthetic-link-root'), alias = resolve(root, 'alias.txt'), target = resolve(root, 'nested/file.txt')
// 合成最终文件链接，无需Windows symlink权限，也不创建真实文件。
const realpath = Object.assign((path: string) => path === alias ? target : path, { native: (path: string) => path === alias ? target : path })
mock.module('node:fs', () => ({ ...actualFs, realpathSync: realpath }))
const { ProjectInstructionScopeController } = await import('./pi-project-instruction-scope')
const { wrapToolWithPermission } = await import('./pi-tool-permission')
const { createWriteToolDefinition } = await import('@earendil-works/pi-coding-agent')

describe('最终文件链接作用域', () => {
  test('Given alias指向子目录文件 When 检查与执行 Then 使用最终目标规则和权限路径', async () => {
    const controller = new ProjectInstructionScopeController({ projectRoot: root, cwd: root, initialSources: [], resolveInstructions: ({ targetPath }) => ({
      projectRoot: root, totalBytes: 4, diagnostics: [], sources: targetPath === dirname(target) ? [{ path: resolve(root, 'nested/AGENTS.md'), relativePath: 'nested/AGENTS.md', scopeRoot: 'nested', kind: 'agents', content: 'RULE', contentHash: 'rule' }] : [],
    }) })
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: alias } })?.block).toBe(true)
    expect(JSON.stringify(controller.projectContext([]))).toContain('RULE')
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: alias } })).toBeUndefined()
    let written = '', approved = ''
    const tool = wrapToolWithPermission(createWriteToolDefinition(root, { operations: { mkdir: async () => {}, writeFile: async (path) => { written = path } } }), {
      canUseTool: async (_name, input) => { approved = input.file_path as string; return { behavior: 'allow' } },
    })
    await tool.execute('link', { path: alias, content: '' }, undefined, undefined, { cwd: root } as ExtensionToolContext)
    expect(approved).toBe(target)
    expect(written).toBe(target)
  })
})
