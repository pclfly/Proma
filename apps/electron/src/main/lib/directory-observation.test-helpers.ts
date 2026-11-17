/**
 * directory-observation 测试用的伪 watcher 与临时目录工具。
 * 文件名不匹配 bun 的 `*.test.ts` 约定，不会被当作测试入口执行。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DirectoryWatchFactory } from './directory-observation'

export interface FakeWatcher {
  readonly path: string
  readonly recursive: boolean
  closed: boolean
  on(event: 'change', listener: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void): void
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void
  close(): void
  emitChange(filename: string | Buffer | null): void
  emitError(error: NodeJS.ErrnoException): void
}

class TestWatcher implements FakeWatcher {
  private readonly changeListeners: Array<(eventType: 'rename' | 'change', filename: string | Buffer | null) => void> = []
  private readonly errorListeners: Array<(error: NodeJS.ErrnoException) => void> = []
  closed = false

  constructor(readonly path: string, readonly recursive: boolean) {}

  on(event: 'change', listener: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void): void
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void
  on(
    event: 'change' | 'error',
    listener:
      | ((eventType: 'rename' | 'change', filename: string | Buffer | null) => void)
      | ((error: NodeJS.ErrnoException) => void),
  ): void {
    if (event === 'change') {
      this.changeListeners.push(listener as (eventType: 'rename' | 'change', filename: string | Buffer | null) => void)
    } else {
      this.errorListeners.push(listener as (error: NodeJS.ErrnoException) => void)
    }
  }

  close(): void {
    this.closed = true
  }

  emitChange(filename: string | Buffer | null): void {
    for (const listener of this.changeListeners) listener('change', filename)
  }

  emitError(error: NodeJS.ErrnoException): void {
    for (const listener of this.errorListeners) listener(error)
  }
}

export interface WatcherRecorder {
  factory: DirectoryWatchFactory
  watchers: FakeWatcher[]
}

export function createRecorder(): WatcherRecorder {
  const watchers: FakeWatcher[] = []
  return {
    factory: (path, options) => {
      const watcher = new TestWatcher(path, options.recursive)
      watchers.push(watcher)
      return watcher
    },
    watchers,
  }
}

export function watcherAt(recorder: WatcherRecorder, index: number): FakeWatcher {
  const watcher = recorder.watchers[index]
  if (!watcher) throw new Error(`第 ${index} 个 watcher 尚未创建`)
  return watcher
}

export const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await wait(10)
  }
}

const tempRoots: string[] = []

export function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-directory-observation-'))
  tempRoots.push(root)
  return root
}

export function cleanupTempRoots(): void {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
}