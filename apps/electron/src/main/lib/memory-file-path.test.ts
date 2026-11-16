import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMemoryPath, writeMemoryFileAtomic } from './memory-file-path'

describe('记忆文件路径', () => {
  test('Given 新文件 When 原子写 Then 自动建目录并写入', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-mem-path-'))
    try {
      const file = join(root, 'nested', 'MEMORY.md')
      writeMemoryFileAtomic(file, '# memory')
      expect(readFileSync(file, 'utf8')).toBe('# memory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 已存在普通文件 When 写入 Then 覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-mem-path-'))
    try {
      const file = join(root, 'MEMORY.md')
      writeFileSync(file, 'old', 'utf8')
      writeMemoryFileAtomic(file, 'new')
      expect(readFileSync(file, 'utf8')).toBe('new')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 目标是目录 When 写入 Then 拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-mem-path-'))
    try {
      const dir = join(root, 'dir')
      mkdirSync(dir)
      expect(() => writeMemoryFileAtomic(dir, 'x')).toThrow('不是普通文件')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 不存在的路径 When resolve Then 返回候选路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-mem-path-'))
    try {
      expect(resolveMemoryPath(join(root, 'missing.md'))).toContain('missing.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
