import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizePreviewPath, isExplicitPreviewFileSelected } from './preview-path-authorization'

let root: string
let base: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-preview-auth-'))
  base = join(root, 'base')
  outside = join(root, 'outside')
  mkdirSync(base)
  mkdirSync(outside)
  writeFileSync(join(base, 'note.md'), '# note')
  writeFileSync(join(outside, 'secret.md'), '# secret')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function policy(overrides: Partial<Parameters<typeof authorizePreviewPath>[1]> = {}) {
  return {
    candidateBasePaths: [base],
    isExplicitPreviewFile: () => true,
    unrestricted: false,
    allowEscapingRelative: false,
    ...overrides,
  }
}

describe('预览路径授权', () => {
  test('Given 候选根内相对文件 When 授权 Then 返回绝对路径', () => {
    expect(authorizePreviewPath('note.md', policy())).toBe(join(base, 'note.md'))
  })

  test('Given 相对路径穿越 When 授权 Then 拒绝', () => {
    expect(authorizePreviewPath('../outside/secret.md', policy())).toBeNull()
    expect(authorizePreviewPath('../outside/secret.md', policy({ allowEscapingRelative: true })))
      .toBe(join(outside, 'secret.md'))
  })

  test('Given 绝对路径且策略拒绝 When 授权 Then 返回 null', () => {
    const target = join(outside, 'secret.md')
    // 绝对路径由 isExplicitPreviewFile 策略决定；真实 IPC 会拒绝未显式授权的文件。
    expect(authorizePreviewPath(target, policy())).toBe(target)
    expect(authorizePreviewPath(target, policy({ isExplicitPreviewFile: () => false }))).toBeNull()
    expect(authorizePreviewPath(target, policy({ unrestricted: true }))).toBe(target)
  })

  test('Given 软链接逃逸 When 授权 Then 拒绝', () => {
    let linked = true
    try {
      symlinkSync(outside, join(base, 'link'), 'dir')
    } catch {
      linked = false
    }
    if (!linked) return
    expect(authorizePreviewPath('link/secret.md', policy())).toBeNull()
  })

  test('Given 空路径或不存在 When 授权 Then 返回 null', () => {
    expect(authorizePreviewPath('', policy({ isExplicitPreviewFile: (path) => path.endsWith('.md') })))
      .toBeNull()
    expect(authorizePreviewPath('missing.md', policy())).toBeNull()
  })
})

describe('用户主动点击的单文件预览授权', () => {
  test('Given 精确匹配的文件 When 判定 Then 放行', () => {
    const target = join(outside, 'secret.md')
    expect(isExplicitPreviewFileSelected(realpathSync(target), [target])).toBe(true)
  })

  test('Given 同目录下未点击的文件 When 判定 Then 拒绝', () => {
    const clicked = join(outside, 'secret.md')
    const sibling = join(outside, 'sibling.md')
    writeFileSync(sibling, '# sibling')
    expect(isExplicitPreviewFileSelected(realpathSync(sibling), [clicked])).toBe(false)
  })

  test('Given 未提供显式文件列表 When 判定 Then 拒绝', () => {
    expect(isExplicitPreviewFileSelected(realpathSync(join(outside, 'secret.md')), undefined)).toBe(false)
    expect(isExplicitPreviewFileSelected(realpathSync(join(outside, 'secret.md')), [])).toBe(false)
  })

  test('Given 软链接指向已选文件 When 判定 Then 按真实路径放行', () => {
    const target = join(outside, 'secret.md')
    const link = join(base, 'secret-link.md')
    let linked = true
    try {
      symlinkSync(target, link, 'file')
    } catch {
      linked = false
    }
    if (!linked) return
    expect(isExplicitPreviewFileSelected(realpathSync(link), [target])).toBe(true)
  })

  test('Given 目录外的文件被用户点击 When 授权 Then 只放行该文件', () => {
    const target = join(outside, 'secret.md')
    const explicitFiles = [target]
    const result = authorizePreviewPath(target, {
      candidateBasePaths: [],
      isExplicitPreviewFile: (path) => isExplicitPreviewFileSelected(realpathSync(path), explicitFiles),
      unrestricted: false,
    })
    expect(result).toBe(target)

    const rejected = authorizePreviewPath(join(base, 'note.md'), {
      candidateBasePaths: [],
      isExplicitPreviewFile: (path) => isExplicitPreviewFileSelected(realpathSync(path), explicitFiles),
      unrestricted: false,
    })
    expect(rejected).toBeNull()
  })
})
