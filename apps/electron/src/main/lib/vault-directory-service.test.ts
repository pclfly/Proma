import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVaultDirectoryService,
  type VaultIdentity,
  type VaultWikiLinkInput,
} from './vault-directory-service'

let root: string
let identity: VaultIdentity
let service: ReturnType<typeof createVaultDirectoryService>

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'proma-vault-index-')))
  identity = { rootPath: root, vaultId: 'vault-1', configuredAt: 1 }
  service = createVaultDirectoryService({
    getVault: async () => identity,
    pageSize: 2,
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function resolveEventually(input: VaultWikiLinkInput) {
  let result = await service.resolveWikiLink(input)
  for (let index = 0; index < 50 && result.status === 'indexing'; index += 1) {
    await new Promise((done) => setTimeout(done, 10))
    result = await service.resolveWikiLink(input)
  }
  return result
}

describe('Vault 异步目录服务', () => {
  test('Given 根目录 When 分页 Then 文件夹优先、游标稳定、同快照续页', async () => {
    mkdirSync(join(root, 'beta'))
    mkdirSync(join(root, 'alpha'))
    writeFileSync(join(root, 'note2.md'), '# 2')
    writeFileSync(join(root, 'note1.md'), '# 1')
    writeFileSync(join(root, 'image.png'), 'x')

    const first = await service.listDirectory({ vaultId: identity.vaultId, relativePath: '' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.entries.map((entry) => `${entry.kind}:${entry.relativePath}`)).toEqual([
      'folder:alpha',
      'folder:beta',
    ])
    expect(first.nextCursor).toBeString()

    const second = await service.listDirectory({
      vaultId: identity.vaultId,
      relativePath: '',
      cursor: first.nextCursor!,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.entries.map((entry) => entry.relativePath)).toEqual(['note1.md', 'note2.md'])
    expect(second.nextCursor).toBeNull()
  })

  test('Given 非法/过期游标 When 续页 Then 返回 STALE_CURSOR', async () => {
    writeFileSync(join(root, 'a.md'), '# a')
    const first = await service.listDirectory({ vaultId: identity.vaultId, relativePath: '' })
    expect(first.ok).toBe(true)
    const stale = await service.listDirectory({
      vaultId: identity.vaultId,
      relativePath: '',
      cursor: 'bad:2',
    })
    expect(stale).toMatchObject({ ok: false, code: 'STALE_CURSOR' })
    const overflow = await service.listDirectory({
      vaultId: identity.vaultId,
      relativePath: '',
      cursor: 'id:999',
    })
    expect(overflow).toMatchObject({ ok: false, code: 'STALE_CURSOR' })
  })

  test('Given refresh When 重新列目录 Then 生成新快照且旧游标失效', async () => {
    writeFileSync(join(root, 'a.md'), '# a')
    const first = await service.listDirectory({ vaultId: identity.vaultId, relativePath: '' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    writeFileSync(join(root, 'b.md'), '# b')
    const refreshed = await service.listDirectory({
      vaultId: identity.vaultId,
      relativePath: '',
      refresh: true,
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.entries.map((entry) => entry.relativePath)).toEqual(['a.md', 'b.md'])
    if (first.nextCursor) {
      const old = await service.listDirectory({
        vaultId: identity.vaultId,
        relativePath: '',
        cursor: first.nextCursor,
      })
      expect(old).toMatchObject({ ok: false, code: 'STALE_CURSOR' })
    }
  })

  test('Given Vault 切换 When 请求旧身份 Then 返回 VAULT_CHANGED', async () => {
    writeFileSync(join(root, 'a.md'), '# a')
    identity = { ...identity, vaultId: 'vault-2', configuredAt: 2 }
    const result = await service.listDirectory({ vaultId: 'vault-1', relativePath: '' })
    expect(result).toMatchObject({ ok: false, code: 'VAULT_CHANGED' })
  })

  test('Given 软链接目录 When 列目录 Then 不跟随', async () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'proma-vault-outside-')))
    try {
      writeFileSync(join(outside, 'secret.md'), '# secret')
      let linked = true
      try {
        symlinkSync(outside, join(root, 'link'), 'dir')
      } catch {
        linked = false
      }
      if (!linked) return
      const listing = await service.listDirectory({ vaultId: identity.vaultId, relativePath: '' })
      expect(listing.ok).toBe(true)
      if (!listing.ok) return
      expect(listing.entries).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('Vault 双链解析', () => {
  test('Given 根路径精确命中 When 解析 Then found', async () => {
    writeFileSync(join(root, 'Target.md'), '# target')
    expect(await service.resolveWikiLink({
      vaultId: identity.vaultId,
      target: 'Target',
      sourcePath: 'source.md',
    })).toEqual({ status: 'found', relativePath: 'Target.md' })
  })

  test('Given 当前目录相对双链 When 解析 Then 优先当前目录', async () => {
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'notes', 'target.md'), '# n')
    writeFileSync(join(root, 'notes', 'source.md'), '# s')
    expect(await service.resolveWikiLink({
      vaultId: identity.vaultId,
      target: './target',
      sourcePath: 'notes/source.md',
    })).toEqual({ status: 'found', relativePath: 'notes/target.md' })
  })

  test('Given 唯一后缀 When 索引建立 Then found；重复同名 Then ambiguous', async () => {
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'a', 'unique.md'), '# u')
    writeFileSync(join(root, 'a', 'dup.md'), '# a')
    writeFileSync(join(root, 'b', 'dup.md'), '# b')
    expect(await resolveEventually({
      vaultId: identity.vaultId,
      target: 'unique',
      sourcePath: 'source.md',
    })).toEqual({ status: 'found', relativePath: 'a/unique.md' })
    expect(await resolveEventually({
      vaultId: identity.vaultId,
      target: 'dup',
      sourcePath: 'source.md',
    })).toEqual({
      status: 'ambiguous',
      message: '存在多个同名笔记，请使用完整的 Vault 内路径',
    })
  })

  test('Given 不存在或非法双链 Then missing/error', async () => {
    writeFileSync(join(root, 'source.md'), '# s')
    expect(await resolveEventually({
      vaultId: identity.vaultId,
      target: 'missing',
      sourcePath: 'source.md',
    })).toEqual({ status: 'missing' })
    expect(await service.resolveWikiLink({
      vaultId: identity.vaultId,
      target: '#heading',
      sourcePath: 'source.md',
    })).toMatchObject({ status: 'error' })
    expect(await service.resolveWikiLink({
      vaultId: identity.vaultId,
      target: 'note',
      sourcePath: 'source.txt',
    })).toMatchObject({ status: 'error' })
  })
})
