import { describe, expect, test } from 'bun:test'
import type { VaultDirectoryListing, VaultTreeEntry } from '@proma/shared'
import { VaultDirectoryController } from './vault-directory-controller'

const folder = (path: string): VaultTreeEntry => ({ kind: 'folder', relativePath: path, name: path.split('/').at(-1) ?? path })
const file = (path: string): VaultTreeEntry => ({ kind: 'file', relativePath: path, name: path.split('/').at(-1) ?? path, size: 1, modifiedAt: 1 })
const listing = (relativePath: string, entries: VaultTreeEntry[], nextOffset?: number): VaultDirectoryListing => ({ relativePath, entries, truncated: nextOffset !== undefined, ...(nextOffset !== undefined ? { nextOffset } : {}) })
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Vault 目录按需加载控制器', () => {
  test('Given 新库 When 初始化并展开 Then 只读取根层和指定目录、重复请求去重', async () => {
    const calls: string[] = []
    const gate = deferred<VaultDirectoryListing>()
    const controller = new VaultDirectoryController(async (_vaultId, path) => {
      calls.push(path)
      return path === '' ? listing('', [folder('a'), folder('b')]) : gate.promise
    })
    controller.setVault('A')
    await controller.load('')
    expect(calls).toEqual([''])
    const first = controller.toggle('a')
    const second = controller.load('a')
    gate.resolve(listing('a', [file('a/n.md')]))
    await Promise.all([first, second])
    expect(calls).toEqual(['', 'a'])
    expect(controller.getSnapshot().expanded.has('a')).toBe(true)
  })

  test('Given 展开尚未返回 When 用户收起 Then 迟到结果可缓存但不重新展开', async () => {
    const gate = deferred<VaultDirectoryListing>()
    const controller = new VaultDirectoryController(async (_id, path) => path ? gate.promise : listing('', [folder('a')]))
    controller.setVault('A'); await controller.load('')
    const pending = controller.toggle('a')
    await controller.toggle('a')
    gate.resolve(listing('a', [file('a/n.md')]))
    await pending
    expect(controller.getSnapshot().expanded.has('a')).toBe(false)
    expect(controller.getSnapshot().directories.has('a')).toBe(true)
  })

  test('Given 旧库目录请求挂起 When 切库 Then 旧结果与finally不污染新库', async () => {
    const old = deferred<VaultDirectoryListing>()
    const controller = new VaultDirectoryController(async (id) => id === 'A' ? old.promise : listing('', [file('new.md')]))
    controller.setVault('A'); const pending = controller.load('')
    controller.setVault('B'); await controller.load('')
    old.resolve(listing('', [file('old.md')]))
    await pending
    expect(controller.getSnapshot().vaultId).toBe('B')
    expect(controller.getSnapshot().directories.get('')?.map((entry) => entry.relativePath)).toEqual(['new.md'])
    expect(controller.getSnapshot().loading.size).toBe(0)
  })

  test('Given 深层笔记未加载 When 定位 Then 逐级读取祖先且不枚举旁支', async () => {
    const calls: string[] = []
    const controller = new VaultDirectoryController(async (_id, path) => {
      calls.push(path)
      return path === '' ? listing('', [folder('a'), folder('other')]) : path === 'a' ? listing('a', [folder('a/b')]) : listing('a/b', [file('a/b/n.md')])
    })
    controller.setVault('A'); await controller.reveal('a/b/n.md')
    expect(calls).toEqual(['', 'a', 'a/b'])
    expect([...controller.getSnapshot().expanded]).toEqual(['a', 'a/b'])
  })

  test('Given 已加载子目录 When 刷新且父级删除 Then 清除失效子缓存但不扫描未展开目录', async () => {
    let removed = false
    const calls: string[] = []
    const controller = new VaultDirectoryController(async (_id, path) => {
      calls.push(path)
      return path === '' ? listing('', removed ? [folder('unread')] : [folder('a'), folder('unread')]) : listing('a', [file('a/n.md')])
    })
    controller.setVault('A'); await controller.load(''); await controller.toggle('a')
    calls.length = 0; removed = true; await controller.refresh()
    expect(calls).toEqual([''])
    expect(controller.getSnapshot().directories.has('a')).toBe(false)
    expect(controller.getSnapshot().expanded.has('a')).toBe(false)
  })

  test('Given 分页目录 When 加载 Then 获取后续页且不静默丢弃超过1000项', async () => {
    const offsets: number[] = []
    const controller = new VaultDirectoryController(async (_id, path, offset) => {
      offsets.push(offset)
      return offset === 0 ? listing(path, [file('one.md')], 1) : listing(path, [file('two.md')])
    })
    controller.setVault('A'); await controller.load('')
    expect(offsets).toEqual([0, 1])
    expect(controller.getSnapshot().directories.get('')?.length).toBe(2)
  })

  test('Given 目录读取失败 When 重试 Then 错误可恢复且不缓存空成功', async () => {
    let failed = true
    const controller = new VaultDirectoryController(async (_id, path) => {
      if (failed) throw new Error('fixture denied')
      return listing(path, [file('ok.md')])
    })
    controller.setVault('A'); expect(await controller.load('')).toBe(false)
    expect(controller.getSnapshot().errors.get('')).toContain('fixture denied')
    failed = false; expect(await controller.load('')).toBe(true)
    expect(controller.getSnapshot().errors.size).toBe(0)
  })

  test('Given 全部展开 When 请求 Then 逐级加载全部目录且可中途折叠取消', async () => {
    const calls: string[] = []
    const controller = new VaultDirectoryController(async (_id, path) => {
      calls.push(path)
      return listing(path, path === '' ? [folder('a')] : path === 'a' ? [folder('a/b')] : [file('a/b/n.md')])
    })
    controller.setVault('A'); await controller.expandAll()
    expect(calls).toEqual(['', 'a', 'a/b'])
    expect([...controller.getSnapshot().expanded]).toEqual(['a', 'a/b'])
    controller.collapseAll()
    expect(controller.getSnapshot().expanded.size).toBe(0)
  })
})

describe('Vault目录复核竞态', () => {
  test('Given 定位正在加载祖先 When 刷新接管 Then 在新epoch继续相同定位意图', async () => {
    const old = deferred<VaultDirectoryListing>()
    let first = true
    const controller = new VaultDirectoryController(async (_id, path) => {
      if (!path) return listing('', [folder('a')])
      if (path === 'a' && first) { first = false; return old.promise }
      return path === 'a' ? listing('a', [folder('a/b')]) : listing('a/b', [file('a/b/n.md')])
    })
    controller.setVault('A'); await controller.load('')
    const navigation = controller.reveal('a/b/n.md')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await controller.refresh()
    old.resolve(listing('a', [folder('a/b')]))
    await navigation
    expect(controller.getSnapshot().directories.has('a/b')).toBe(true)
    expect(controller.getSnapshot().expanded.has('a/b')).toBe(true)
  })
  test('Given 根刷新已删除目录 When 同epoch子响应迟到 Then 不重建幽灵子树', async () => {
    const parent = deferred<VaultDirectoryListing>(), child = deferred<VaultDirectoryListing>()
    let refresh = false
    const controller = new VaultDirectoryController(async (_id, path) => path ? child.promise : refresh ? parent.promise : listing('', [folder('a')]))
    controller.setVault('A'); await controller.load(''); refresh = true
    const refreshing = controller.refresh()
    const expanding = controller.toggle('a')
    parent.resolve(listing('', [])); await refreshing
    child.resolve(listing('a', [file('a/n.md')])); await expanding
    expect(controller.getSnapshot().directories.has('a')).toBe(false)
  })
  test('Given 全部展开挂起 When 用户改为定位 Then 活动态正确取消', async () => {
    const child = deferred<VaultDirectoryListing>()
    const controller = new VaultDirectoryController(async (_id, path) => path ? child.promise : listing('', [folder('a'), file('root.md')]))
    controller.setVault('A')
    const expanding = controller.expandAll()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await controller.reveal('root.md')
    child.resolve(listing('a', [])); await expanding
    expect(controller.getSnapshot().expandingAll).toBe(false)
  })
  test('Given 只更新保存元数据 When 路径名称不变 Then 不让目录Map失效重建全树', async () => {
    const controller = new VaultDirectoryController(async () => listing('', [file('root.md')]))
    controller.setVault('A'); await controller.load('')
    const before = controller.getSnapshot().directories
    controller.updateFile({ kind: 'file', relativePath: 'root.md', name: 'root.md', size: 20, modifiedAt: 2 })
    expect(controller.getSnapshot().directories).toBe(before)
  })
})

test('Given 刷新期间出现新祖先 When 新定位使用旧缓存后被接管 Then 刷新结束继续最新意图', async () => {
  const parent = deferred<VaultDirectoryListing>()
  let refreshing = false
  const controller = new VaultDirectoryController(async (_id, path) => !path ? listing('', [folder('a')]) : path === 'a' ? refreshing ? parent.promise : listing('a', []) : listing('a/b', [file('a/b/n.md')]))
  controller.setVault('A'); await controller.load(''); await controller.load('a')
  refreshing = true
  const refresh = controller.refresh()
  await controller.reveal('a/b/n.md')
  parent.resolve(listing('a', [folder('a/b')]))
  await refresh
  expect(controller.getSnapshot().directories.has('a/b')).toBe(true)
})

test('Given 深层定位的祖先失败 When 点击目录重试 Then 恢复后继续定位余下祖先', async () => {
  let fails = true
  const controller = new VaultDirectoryController(async (_id, path) => {
    if (!path) return listing('', [folder('a')])
    if (path === 'a') { if (fails) throw new Error('temporary'); return listing('a', [folder('a/b')]) }
    return listing('a/b', [file('a/b/n.md')])
  })
  controller.setVault('A'); await controller.reveal('a/b/n.md')
  fails = false; await controller.retry('a')
  expect(controller.getSnapshot().directories.has('a/b')).toBe(true)
  expect(controller.getSnapshot().expanded.has('a/b')).toBe(true)
})
