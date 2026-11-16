import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeTreeEntry,
  type TreeDeleteDeps,
} from './file-tree-delete'

interface DeleteFixture {
  root: string
  workspace: string
  external: string
  cleanup: () => void
}

function createFixture(): DeleteFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-tree-delete-'))
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(external, { recursive: true })
  return {
    root,
    workspace,
    external,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  }
}

function canCreateJunction(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), 'proma-tree-delete-probe-'))
  try {
    mkdirSync(join(probeRoot, 'target'))
    symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

const junctionSupported = canCreateJunction()

describe('文件树安全删除', () => {
  test('Given 普通文件 When 删除 Then removed 为 true 且文件消失', () => {
    const fixture = createFixture()
    try {
      const target = join(fixture.workspace, 'note.txt')
      writeFileSync(target, 'note')
      const result = removeTreeEntry(target, { root: fixture.workspace })
      expect(result).toEqual({ removed: true, skipped: [] })
      expect(existsSync(target)).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!junctionSupported)('Given 指向根外的目录链接 When 删除链接 Then 只删除链接并保留目标内容', () => {
    const fixture = createFixture()
    try {
      writeFileSync(join(fixture.external, 'keep.txt'), 'keep')
      const linkPath = join(fixture.workspace, 'escape')
      symlinkSync(fixture.external, linkPath, 'junction')

      const readdirCalls: string[] = []
      const deps: Partial<TreeDeleteDeps> = {
        readdir: (target) => {
          readdirCalls.push(target)
          return readdirSync(target)
        },
      }
      const result = removeTreeEntry(linkPath, { root: fixture.workspace, deps })

      expect(result).toEqual({ removed: true, skipped: [] })
      expect(() => lstatSync(linkPath)).toThrow()
      expect(readFileSync(join(fixture.external, 'keep.txt'), 'utf8')).toBe('keep')
      // 链接本身被删除，删除流程从未进入链接目标目录。
      expect(readdirCalls).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!junctionSupported)('Given 目录内含指向根外的链接 When 删除父目录 Then 不跟随链接且保留目标内容', () => {
    const fixture = createFixture()
    try {
      writeFileSync(join(fixture.external, 'keep.txt'), 'keep')
      const tree = join(fixture.workspace, 'tree')
      mkdirSync(tree)
      writeFileSync(join(tree, 'note.txt'), 'note')
      symlinkSync(fixture.external, join(tree, 'escape'), 'junction')

      const result = removeTreeEntry(tree, { root: fixture.workspace })

      expect(result).toEqual({ removed: true, skipped: [] })
      expect(() => lstatSync(tree)).toThrow()
      expect(readFileSync(join(fixture.external, 'keep.txt'), 'utf8')).toBe('keep')
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!junctionSupported)('Given 待删除路径的父级是链接 When 删除链接内文件 Then 拒绝且目标文件保留', () => {
    const fixture = createFixture()
    try {
      writeFileSync(join(fixture.external, 'secret.txt'), 'secret')
      symlinkSync(fixture.external, join(fixture.workspace, 'escape'), 'junction')

      expect(() => removeTreeEntry(join(fixture.workspace, 'escape', 'secret.txt'), {
        root: fixture.workspace,
      })).toThrow('经过链接')
      expect(readFileSync(join(fixture.external, 'secret.txt'), 'utf8')).toBe('secret')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 授权根目录本身 When 删除 Then 抛错且根目录保留', () => {
    const fixture = createFixture()
    try {
      writeFileSync(join(fixture.workspace, 'note.txt'), 'note')
      expect(() => removeTreeEntry(fixture.workspace, { root: fixture.workspace }))
        .toThrow('不能删除授权根目录本身')
      expect(() => removeTreeEntry(join(fixture.workspace, '.'), { root: fixture.workspace }))
        .toThrow('不能删除授权根目录本身')
      expect(existsSync(join(fixture.workspace, 'note.txt'))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 授权根之外的路径 When 删除 Then 抛错且文件保留', () => {
    const fixture = createFixture()
    try {
      const outsideFile = join(fixture.external, 'secret.txt')
      writeFileSync(outsideFile, 'secret')
      expect(() => removeTreeEntry(outsideFile, { root: fixture.workspace }))
        .toThrow('超出授权根目录')
      expect(readFileSync(outsideFile, 'utf8')).toBe('secret')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 不存在的条目 When 删除 Then 不抛错并按 skipped 报告', () => {
    const fixture = createFixture()
    try {
      const target = join(fixture.workspace, 'missing.txt')
      expect(removeTreeEntry(target, { root: fixture.workspace })).toEqual({
        removed: false,
        skipped: [target],
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 注入 unlink 部分失败 When 删除目录 Then 跳过失败项并报告，其余文件已删除', () => {
    const fixture = createFixture()
    try {
      const tree = join(fixture.workspace, 'partial')
      mkdirSync(tree)
      writeFileSync(join(tree, 'a.txt'), 'a')
      writeFileSync(join(tree, 'b.txt'), 'b')
      const failingPath = join(tree, 'b.txt')

      const deps: Partial<TreeDeleteDeps> = {
        unlink: (target) => {
          if (target === failingPath) throw new Error('EPERM')
          unlinkSync(target)
        },
      }
      const result = removeTreeEntry(tree, { root: fixture.workspace, deps })

      expect(result.removed).toBe(false)
      expect(result.skipped).toContain(failingPath)
      expect(result.skipped).toContain(tree)
      expect(existsSync(join(tree, 'a.txt'))).toBe(false)
      expect(existsSync(failingPath)).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 注入 readdir 失败 When 删除目录 Then 不删除目录并报告', () => {
    const fixture = createFixture()
    try {
      const tree = join(fixture.workspace, 'locked')
      mkdirSync(tree)
      writeFileSync(join(tree, 'a.txt'), 'a')

      const deps: Partial<TreeDeleteDeps> = {
        readdir: () => { throw new Error('EACCES') },
      }
      const result = removeTreeEntry(tree, { root: fixture.workspace, deps })

      expect(result).toEqual({ removed: false, skipped: [tree] })
      expect(existsSync(join(tree, 'a.txt'))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!junctionSupported)('Given 授权根自身是链接 When 删除 Then 拒绝且不触碰目标', () => {
    const fixture = createFixture()
    try {
      writeFileSync(join(fixture.workspace, 'note.txt'), 'note')
      const linkedRoot = join(fixture.root, 'linked-root')
      symlinkSync(fixture.workspace, linkedRoot, 'junction')

      expect(() => removeTreeEntry(join(linkedRoot, 'note.txt'), { root: linkedRoot }))
        .toThrow('授权根目录不安全')
      expect(existsSync(join(fixture.workspace, 'note.txt'))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 空路径或缺少授权根 When 删除 Then 拒绝', () => {
    const fixture = createFixture()
    try {
      expect(() => removeTreeEntry('', { root: fixture.workspace })).toThrow('不能为空')
      expect(() => removeTreeEntry(join(fixture.workspace, 'note.txt'), { root: '' }))
        .toThrow('必须指定授权根目录')
    } finally {
      fixture.cleanup()
    }
  })
})
