import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileChange, readFileChangeSnapshot } from './file-change-diff'

describe('文件变更快照与 diff', () => {
  test('Given 文本文件 When 读取快照 Then 返回签名和正文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-change-'))
    try {
      const path = join(dir, 'a.txt')
      writeFileSync(path, 'hello\n', 'utf8')
      const snapshot = readFileChangeSnapshot(path)!
      expect(snapshot.signature).toHaveLength(64)
      expect(snapshot.text).toBe('hello\n')
      expect(readFileChangeSnapshot(join(dir, 'missing.txt'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 创建/修改/删除 When 生成变更 Then kind 与 preview 正确', () => {
    const created = createFileChange('a.ts', undefined, { signature: 's1', text: 'line1\nline2' }, 100)!
    expect(created.kind).toBe('created')
    expect(created.diffAvailable).toBe(true)
    expect(created.preview).toBe('line1')
    expect(created.diff?.addedTotal).toBe(2)

    const modified = createFileChange('a.ts', { signature: 's1', text: 'old' }, { signature: 's2', text: 'new' }, 101)!
    expect(modified.kind).toBe('modified')
    expect(modified.diff?.removedTotal).toBe(1)
    expect(modified.diff?.addedTotal).toBe(1)

    const deleted = createFileChange('a.ts', { signature: 's2', text: 'new' }, undefined, 102)!
    expect(deleted.kind).toBe('deleted')
    expect(deleted.preview).toBe('new')
  })

  test('Given 二进制或超大快照 When 生成变更 Then diffAvailable=false', () => {
    const binary = createFileChange('a.bin', undefined, { signature: 'binary:abc' }, 1)!
    expect(binary.diffAvailable).toBe(false)
    expect(binary.diff).toBeUndefined()

    const large = createFileChange('a.log', { signature: 'large:1:1' }, { signature: 'large:2:2' }, 2)!
    expect(large.diffAvailable).toBe(false)
  })

  test('Given 快照签名一致 When 生成变更 Then 不产生记录', () => {
    expect(createFileChange('a.ts', { signature: 'same' }, { signature: 'same' }, 1)).toBeUndefined()
  })
})
