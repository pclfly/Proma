import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultFileSystem } from './vault-service'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-vault-dir-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Vault 单层目录列表', () => {
  test('Given 根目录混有子目录与文件 When 列目录 Then 只返回一层且文件夹优先', () => {
    mkdirSync(join(root, 'beta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'alpha', 'deep'))
    writeFileSync(join(root, 'note2.md'), '# 2')
    writeFileSync(join(root, 'note10.md'), '# 10')
    writeFileSync(join(root, 'note1.md'), '# 1')
    writeFileSync(join(root, 'image.png'), 'x')
    mkdirSync(join(root, '.obsidian'))
    writeFileSync(join(root, '.hidden.md'), '# h')

    const listing = createVaultFileSystem(root).listDirectory('')

    expect(listing.relativePath).toBe('')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.relativePath}`)).toEqual([
      'folder:alpha',
      'folder:beta',
      'file:note1.md',
      'file:note2.md',
      'file:note10.md',
    ])
    // 子目录内容不在本层返回，必须由展开动作单独请求。
    expect(listing.entries.some((entry) => entry.relativePath === 'alpha/deep')).toBe(false)
  })

  test('Given 子目录 When 列该层 Then 返回其直接子项且路径相对根目录', () => {
    mkdirSync(join(root, 'notes', 'sub'), { recursive: true })
    writeFileSync(join(root, 'notes', 'a.md'), '# a')
    writeFileSync(join(root, 'notes', 'sub', 'b.md'), '# b')

    const listing = createVaultFileSystem(root).listDirectory('notes')

    expect(listing.relativePath).toBe('notes')
    expect(listing.entries.map((entry) => entry.relativePath)).toEqual(['notes/sub', 'notes/a.md'])
  })

  test('Given 越界或隐藏路径 When 列目录 Then 拒绝且不泄露目录内容', () => {
    mkdirSync(join(root, 'safe'))
    mkdirSync(join(root, '.obsidian'))
    const fs = createVaultFileSystem(root)

    expect(() => fs.listDirectory('../outside')).toThrow()
    expect(() => fs.listDirectory('.obsidian')).toThrow()
    expect(() => fs.listDirectory('safe/../safe')).toThrow()
    expect(() => fs.listDirectory(root)).toThrow()
  })

  test('Given 目标不是目录 When 列目录 Then 报错而不是回退到父级', () => {
    writeFileSync(join(root, 'note.md'), '# n')
    const fs = createVaultFileSystem(root)

    expect(() => fs.listDirectory('note.md')).toThrow()
    expect(() => fs.listDirectory('missing')).toThrow()
  })

  test('Given 单层条目超过上限 When 列目录 Then 截断并显式标记', () => {
    for (let index = 0; index < 1_005; index += 1) {
      writeFileSync(join(root, `n${index}.md`), '# n')
    }

    const listing = createVaultFileSystem(root).listDirectory('')

    expect(listing.entries.length).toBe(1_000)
    expect(listing.truncated).toBe(true)
    expect(listing.nextOffset).toBe(1_000)
    const next = createVaultFileSystem(root).listDirectory('', listing.nextOffset)
    expect(next.entries.length).toBe(5)
    expect(next.truncated).toBe(false)
    expect(new Set([...listing.entries, ...next.entries].map((entry) => entry.relativePath)).size).toBe(1_005)
  })

  test('Given 中间目录是外置junction When 请求深层目录 Then 拒绝而不枚举授权根外内容', () => {
    const outside = mkdtempSync(join(tmpdir(), 'proma-vault-outside-'))
    try {
      mkdirSync(join(outside, 'deep'))
      writeFileSync(join(outside, 'deep', 'secret.md'), 'fixture')
      symlinkSync(outside, join(root, 'linked'), 'junction')
      expect(() => createVaultFileSystem(root).listDirectory('linked/deep')).toThrow()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('Given 非法分页偏移 When 请求 Then 拒绝而不是绕过页面边界', () => {
    const fs = createVaultFileSystem(root)
    for (const offset of [-1, 0.5, Number.NaN, Infinity]) expect(() => fs.listDirectory('', offset)).toThrow()
  })
})
