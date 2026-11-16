import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMemoryFileChange } from '@proma/shared'
import { inspectCanonicalKnowledgeDirectory, knowledgePathKey, type KnowledgeAccessPolicy } from './workspace-knowledge-access'
import { notifyWorkspaceKnowledgePolicyChanged } from './workspace-knowledge-policy-events'

mock.module('./agent-workspace-manager', () => ({ getWorkspaceKnowledgePolicy: () => { throw new Error('test必须注入合成policy') } }))
const { WorkspaceMemoryWatcher } = await import('./workspace-memory-change-watcher')
const temporary = mkdtempSync(join(tmpdir(), 'proma-memory-watch-'))
afterAll(() => { rmSync(temporary, { recursive: true, force: true }) })
let sequence = 0
function directoryLink(target: string, path: string): void { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir') }
function fixture() {
  const slug = `watch-${++sequence}`
  const directory = join(temporary, slug)
  mkdirSync(join(directory, 'memory'), { recursive: true })
  const anchor = realpathSync(directory), memory = join(anchor, 'memory')
  const grants: string[] = []
  const policy = (): KnowledgeAccessPolicy => ({ anchor, logicalRoot: memory, authorizedDirectories: [...grants] })
  const watches: Array<{ path: string; closed: boolean; callback: (event: string, filename: string | Buffer | null) => void }> = []
  const create = () => new WorkspaceMemoryWatcher(slug, { getPolicy: policy, watch: (path, callback) => {
    const record = { path, callback, closed: false }; watches.push(record)
    return { close: () => { record.closed = true }, on: () => {} }
  } })
  return { slug, anchor, memory, grants, policy, create, watches }
}

describe('受限记忆监听与授权生命周期', () => {
  test('Given 链接之后仍有普通兄弟 When 首扫与刷新 Then 不因链接break遗漏兄弟', () => {
    const item = fixture(), outside = join(temporary, `${item.slug}-outside`)
    mkdirSync(outside); writeFileSync(join(outside, 'secret.md'), 'private')
    directoryLink(outside, join(item.memory, 'a-link'))
    writeFileSync(join(item.memory, 'z-after.md'), 'before')
    const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
    const stop = watcher.subscribe(change => changes.push(change))
    try {
      expect(watcher.diagnostics.files).toBe(1)
      writeFileSync(join(item.memory, 'z-after.md'), 'after')
      watcher.rescan()
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ relativePath: 'z-after.md', kind: 'modified', diff: { removed: ['before'], added: ['after'] } })
    } finally { stop() }
  })

  test('Given 两个授权别名 When 外置文件改变 Then canonical监听只一次并按两个逻辑路径刷新', () => {
    const item = fixture(), external = join(temporary, `${item.slug}-external`)
    mkdirSync(external); writeFileSync(join(external, 'note.md'), 'one')
    item.grants.push(realpathSync(external))
    directoryLink(external, join(item.memory, 'first')); directoryLink(external, join(item.memory, 'second'))
    const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
    const stop = watcher.subscribe(change => changes.push(change))
    try {
      expect(item.watches.filter(record => !record.closed && knowledgePathKey(record.path) === knowledgePathKey(external))).toHaveLength(1)
      writeFileSync(join(external, 'note.md'), 'two'); watcher.rescan()
      expect(changes.map(change => change.relativePath).sort()).toEqual(['first/note.md', 'second/note.md'])
      expect(changes.every(change => !('source' in change))).toBe(true)
    } finally { stop() }
  })

  test('Given pending外置变更和正文快照 When 撤销grant Then 同步释放watch/正文/timer且无迟到diff', () => {
    const item = fixture(), external = join(temporary, `${item.slug}-external`)
    mkdirSync(external); writeFileSync(join(external, 'note.md'), 'secret snapshot')
    item.grants.push(realpathSync(external)); directoryLink(external, join(item.memory, 'linked'))
    const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
    const stop = watcher.subscribe(change => changes.push(change))
    const native = item.watches.find(record => knowledgePathKey(record.path) === knowledgePathKey(external))
    try {
      expect(watcher.diagnostics.retainedTextBytes).toBeGreaterThan(0)
      native?.callback('change', 'note.md'); expect(watcher.diagnostics.pending).toBe(true)
      item.grants.length = 0; notifyWorkspaceKnowledgePolicyChanged(item.slug)
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
      expect(watcher.diagnostics.watches).toBe(0)
      expect(changes).toMatchObject([{ accessChanged: true, diffAvailable: false }])
      watcher.rescan(); writeFileSync(join(external, 'note.md'), 'changed after revoke'); native?.callback('change', 'note.md'); watcher.rescan()
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
      expect(changes.every(change => !change.diff && !change.preview)).toBe(true)
      expect(item.watches.filter(record => !record.closed && knowledgePathKey(record.path) === knowledgePathKey(external))).toHaveLength(0)
    } finally { stop() }
    expect(watcher.diagnostics).toMatchObject({ closed: true, pending: false, watches: 0, files: 0 })
  })

  test('Given 普通父目录被换成未授权外链 When 旧事件消费 Then 不读取新外部正文或发送旧delete diff', () => {
    const item = fixture(), folder = join(item.memory, 'folder'), external = join(temporary, `${item.slug}-external`)
    mkdirSync(folder); mkdirSync(external); writeFileSync(join(folder, 'note.md'), 'before'); writeFileSync(join(external, 'note.md'), 'private')
    const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
    const stop = watcher.subscribe(change => changes.push(change))
    try {
      rmSync(folder, { recursive: true }); directoryLink(external, folder); watcher.rescan()
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
      expect(changes).toMatchObject([{ accessChanged: true, diffAvailable: false }])
      expect(changes[0]?.diff).toBeUndefined()
    } finally { stop() }
  })

  test('Given 多个同实例订阅者 When 一个取消 Then 另一个保留，最后取消释放所有资源', () => {
    const item = fixture(); writeFileSync(join(item.memory, 'a.md'), 'one')
    const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
    const first = watcher.subscribe(() => {}), last = watcher.subscribe(change => changes.push(change))
    first(); expect(watcher.diagnostics.closed).toBe(false)
    writeFileSync(join(item.memory, 'a.md'), 'two'); watcher.rescan(); expect(changes).toHaveLength(1)
    last(); expect(watcher.diagnostics).toMatchObject({ closed: true, watches: 0, files: 0, retainedTextBytes: 0, pending: false })
  })

  test('Given 目录自循环和多个别名 When 扫描/删除后重建 Then 有界且保留恢复原名称的metadata监听', () => {
    const item = fixture(), external = join(temporary, `${item.slug}-external`)
    mkdirSync(external); writeFileSync(join(external, 'note.md'), 'one'); item.grants.push(realpathSync(external))
    directoryLink(external, join(item.memory, 'linked')); directoryLink(external, join(external, 'loop'))
    const watcher = item.create(), stop = watcher.subscribe(() => {})
    try {
      expect(watcher.diagnostics.files).toBe(1); expect(watcher.diagnostics.watches).toBeLessThanOrEqual(160)
      unlinkSync(join(external, 'loop')); rmSync(external, { recursive: true }); watcher.rescan()
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
      expect(item.watches.some(record => !record.closed && knowledgePathKey(record.path) === knowledgePathKey(temporary))).toBe(true)
      mkdirSync(external); writeFileSync(join(external, 'note.md'), 'restored'); watcher.rescan()
      expect(watcher.diagnostics.files).toBe(1)
    } finally { stop() }
  })
})

test('Given 目录同名换成新实体 When 重扫 Then 关闭旧inode的native句柄并重建监听', async () => {
  const item = fixture(), folder = join(item.memory, 'folder')
  mkdirSync(folder); writeFileSync(join(folder, 'note.md'), 'before')
  const watcher = item.create(), stop = watcher.subscribe(() => {})
  try {
    const first = item.watches.find(record => knowledgePathKey(record.path) === knowledgePathKey(folder))
    expect(first).toBeDefined()
    const before = inspectCanonicalKnowledgeDirectory(folder)
    renameSync(folder, `${folder}-moved`); mkdirSync(folder); writeFileSync(join(folder, 'note.md'), 'new entity')
    // Windows 在并发负载下可能短暂返回重命名前的目录身份；等新实体可见再重扫，
    // 避免把 OS 路径缓存延迟误判成 watch 复用。
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = inspectCanonicalKnowledgeDirectory(folder)
      if (current.dev !== before.dev || current.ino !== before.ino) break
      await Bun.sleep(2)
    }
    watcher.rescan()
    expect(first?.closed).toBe(true)
    expect(item.watches.filter(record => knowledgePathKey(record.path) === knowledgePathKey(folder))).toHaveLength(2)
    expect(item.watches.filter(record => !record.closed && knowledgePathKey(record.path) === knowledgePathKey(folder))).toHaveLength(1)
  } finally { stop() }
})

test('Given flush中同步撤销grant When 当前回调触发reset Then reset之后不再发送旧正文diff', () => {
  const item = fixture(), external = join(temporary, `${item.slug}-reentrant`)
  mkdirSync(external); writeFileSync(join(external, 'a.md'), 'a-before'); writeFileSync(join(external, 'b.md'), 'b-before')
  item.grants.push(realpathSync(external)); directoryLink(external, join(item.memory, 'linked'))
  const watcher = item.create(), delivered: WorkspaceMemoryFileChange[] = []
  let revoked = false
  const first = watcher.subscribe(change => { delivered.push(change); if (!change.accessChanged && !revoked) { revoked = true; item.grants.length = 0; notifyWorkspaceKnowledgePolicyChanged(item.slug) } })
  const second = watcher.subscribe(change => delivered.push(change))
  try {
    writeFileSync(join(external, 'a.md'), 'a-after'); writeFileSync(join(external, 'b.md'), 'b-after'); watcher.rescan()
    const reset = delivered.findIndex(change => change.accessChanged)
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(delivered.slice(reset).every(change => !change.diff && !change.preview)).toBe(true)
    expect(watcher.diagnostics.retainedTextBytes).toBe(0)
  } finally { first(); second() }
})

test('Given 512预算遗漏的既有文件 When 减少其他文件后重新纳入 Then 不猜测其为created', () => {
  const item = fixture()
  for (let index = 0; index < 513; index += 1) writeFileSync(join(item.memory, `${String(index).padStart(4, '0')}.md`), '')
  const watcher = item.create(), changes: WorkspaceMemoryFileChange[] = []
  const stop = watcher.subscribe(change => changes.push(change))
  try {
    expect(watcher.diagnostics.files).toBe(512)
    unlinkSync(join(item.memory, '0000.md')); watcher.rescan()
    expect(changes.some(change => change.kind === 'created')).toBe(false)
    expect(watcher.diagnostics.files).toBe(512)
  } finally { stop() }
}, 15_000) // 含513个真实文件的两轮逐段安全扫描；这是语义回归，不是性能验收。
