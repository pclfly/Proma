import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultFileSystem } from './vault-service'
import { setKnowledgeMutationInvalidator } from './knowledge-mutation-invalidation'
import { bindWorkspaceKnowledgeScope, configureWorkspaceKnowledgeAttribution } from './workspace-knowledge-mutation-runtime'

let root: string
const invalidated: string[] = []
let release: (() => void) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-vault-knowledge-'))
})
afterEach(() => {
  setKnowledgeMutationInvalidator(undefined)
  configureWorkspaceKnowledgeAttribution(undefined)
  release?.()
  release = undefined
  invalidated.length = 0
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('Vault 写入与记忆来源竞争', () => {
  test('Given Vault与记忆指向同一物理文件 When 用户在Vault保存 Then 提交前失效同目标来源候选', () => {
    const note = join(root, 'shared.md')
    writeFileSync(note, 'v1')
    setKnowledgeMutationInvalidator(path => { invalidated.push(path) })
    const files = createVaultFileSystem(root)
    const result = files.writeFile({ relativePath: 'shared.md', content: 'v2' })
    expect(result.ok).toBe(true)
    expect(readFileSync(note, 'utf8')).toBe('v2')
    // 失效发生在提交边界，且指向用户实际保存的物理目标。
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]!.toLowerCase()).toContain('shared.md')
  })

  test('Given 保存失败或冲突 When 期望版本不匹配 Then 不失效也不改文件', () => {
    writeFileSync(join(root, 'conflict.md'), 'current')
    setKnowledgeMutationInvalidator(path => { invalidated.push(path) })
    const result = createVaultFileSystem(root).writeFile({ relativePath: 'conflict.md', content: 'mine', expectedSha256: 'deadbeef' })
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(invalidated).toEqual([])
    expect(readFileSync(join(root, 'conflict.md'), 'utf8')).toBe('current')
  })
})
