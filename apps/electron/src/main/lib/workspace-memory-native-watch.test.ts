import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMemoryFileChange } from '@proma/shared'
import type { KnowledgeAccessPolicy } from './workspace-knowledge-access'
import { notifyWorkspaceKnowledgePolicyChanged } from './workspace-knowledge-policy-events'
import { rmSyncWithRetry } from './fs-retry'

mock.module('./agent-workspace-manager', () => ({ getWorkspaceKnowledgePolicy: () => { throw new Error('本测试只允许合成policy') } }))
const { WorkspaceMemoryWatcher } = await import('./workspace-memory-change-watcher')

/** 等待原生fs.watch事件，不调用rescan或注入watch工厂。不是Electron窗口/renderer验收。 */
describe('记忆外链的原生文件系统监听', () => {
  test('Given 两个已授权别名 When 原生文件事件到达再撤销 Then 双别名刷新且撤销无正文迟到', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'proma-native-memory-'))
    const anchor = join(temp, 'workspace'), external = join(temp, 'external')
    mkdirSync(join(anchor, 'memory'), { recursive: true }); mkdirSync(external)
    const memory = join(realpathSync(anchor), 'memory'), note = join(external, 'note.md')
    writeFileSync(note, 'before')
    for (const name of ['first', 'second']) symlinkSync(external, join(memory, name), process.platform === 'win32' ? 'junction' : 'dir')
    const grants = [realpathSync(external)], slug = 'native-watch-fixture'
    const getPolicy = (): KnowledgeAccessPolicy => ({ anchor: realpathSync(anchor), logicalRoot: memory, authorizedDirectories: [...grants] })
    const watcher = new WorkspaceMemoryWatcher(slug, { getPolicy })
    const changes: WorkspaceMemoryFileChange[] = []
    let resolveChanges: (() => void) | undefined
    const arrived = new Promise<void>(resolve => { resolveChanges = resolve })
    const stop = watcher.subscribe(change => {
      changes.push(change)
      if (changes.filter(item => item.kind === 'modified' && !item.accessChanged).length >= 2) resolveChanges?.()
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      writeFileSync(note, 'after')
      await Promise.race([arrived, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('原生watch事件未在预算内到达')), 6000) })])
      if (timeout) clearTimeout(timeout)
      expect(changes.map(change => change.relativePath).sort()).toEqual(['first/note.md', 'second/note.md'])
      expect(changes.every(change => change.diff?.added[0] === 'after' && !('source' in change))).toBe(true)
      grants.length = 0
      notifyWorkspaceKnowledgePolicyChanged(slug)
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
      expect(changes.at(-1)).toMatchObject({ accessChanged: true, diffAvailable: false })
      const sinceRevoke = changes.length
      writeFileSync(note, 'private-after-revoke')
      // 留出真实debounce窗口检查迟到事件；不主动扫描或伪造事件。
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(changes.slice(sinceRevoke).every(change => !change.preview && !change.diff)).toBe(true)
      expect(watcher.diagnostics.retainedTextBytes).toBe(0)
    } finally {
      if (timeout) clearTimeout(timeout)
      stop()
      expect(watcher.diagnostics).toMatchObject({ closed: true, watches: 0, pending: false })
      rmSyncWithRetry(temp, { recursive: true, force: true })
    }
  }, 10000)
})
