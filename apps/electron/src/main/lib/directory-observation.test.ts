import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDirectoryObservation } from './directory-observation'
import type { DirectoryObservationChange } from './directory-observation'
import {
  cleanupTempRoots,
  createRecorder,
  createTempRoot,
  wait,
  waitFor,
  watcherAt,
} from './directory-observation.test-helpers'

afterEach(cleanupTempRoots)

describe('createDirectoryObservation', () => {
  it('合并同一 debounce 窗口内的事件并对路径去重', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'a.ts'), '')
    writeFileSync(join(root, 'b.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      expect(observation.available).toBe(true)
      expect(observation.mode).toBe('recursive')

      const watcher = watcherAt(recorder, 0)
      watcher.emitChange('a.ts')
      watcher.emitChange('a.ts')
      watcher.emitChange('b.ts')
      expect(changes).toHaveLength(0)

      await wait(40)

      expect(changes).toHaveLength(1)
      expect(changes[0]?.root).toBe(resolve(root))
      expect(changes[0]?.rootUnavailable).toBe(false)
      expect([...(changes[0]?.paths ?? [])].sort()).toEqual([join(root, 'a.ts'), join(root, 'b.ts')].sort())
    } finally {
      observation.dispose()
    }
  })

  it('默认忽略高频噪声目录', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'app.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      const watcher = watcherAt(recorder, 0)
      watcher.emitChange('node_modules/pkg/index.js')
      watcher.emitChange('.git/objects/pack.idx')
      watcher.emitChange('dist/main.js')
      await wait(40)
      expect(changes).toHaveLength(0)

      watcher.emitChange('app.ts')
      await wait(40)
      expect(changes).toHaveLength(1)
      expect(changes[0]?.paths).toEqual([join(root, 'app.ts')])
    } finally {
      observation.dispose()
    }
  })

  it('自定义忽略规则按相对路径生效', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'app.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      ignore: (relativePath) => relativePath.startsWith('vendor/'),
      onChange: (change) => changes.push(change),
    })

    try {
      const watcher = watcherAt(recorder, 0)
      watcher.emitChange('vendor/lib.ts')
      await wait(40)
      expect(changes).toHaveLength(0)

      watcher.emitChange('app.ts')
      await wait(40)
      expect(changes).toHaveLength(1)
      expect(changes[0]?.paths).toEqual([join(root, 'app.ts')])
    } finally {
      observation.dispose()
    }
  })

  it('根监听出错时只通知一次并释放句柄', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'a.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      const watcher = watcherAt(recorder, 0)
      const error = Object.assign(new Error('EPERM'), { code: 'EPERM' }) as NodeJS.ErrnoException
      watcher.emitError(error)

      await wait(40)

      expect(changes).toHaveLength(1)
      expect(changes[0]?.rootUnavailable).toBe(true)
      expect(observation.isObserving(root)).toBe(false)
      expect(watcher.closed).toBe(true)

      watcher.emitError(error)
      watcher.emitChange('a.ts')
      await wait(40)
      expect(changes).toHaveLength(1)
    } finally {
      observation.dispose()
    }
  })

  it('根目录被删除后事件标记 rootUnavailable 且不抛异常', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'a.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      const watcher = watcherAt(recorder, 0)
      rmSync(root, { recursive: true, force: true })
      watcher.emitChange('a.ts')
      await wait(40)

      expect(changes).toHaveLength(1)
      expect(changes[0]?.rootUnavailable).toBe(true)
      expect(changes[0]?.root).toBe(resolve(root))
    } finally {
      observation.dispose()
    }
  })

  it('dispose 关闭监听并丢弃尚未派发的事件', async () => {
    const root = createTempRoot()
    writeFileSync(join(root, 'a.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    const watcher = watcherAt(recorder, 0)
    watcher.emitChange('a.ts')
    observation.dispose()

    await wait(40)

    expect(changes).toHaveLength(0)
    expect(watcher.closed).toBe(true)
    expect(observation.available).toBe(false)
    expect(() => observation.dispose()).not.toThrow()
  })

  it('setRoots 增量新增与移除根监听', async () => {
    const rootA = createTempRoot()
    const rootB = createTempRoot()
    writeFileSync(join(rootA, 'a.ts'), '')
    writeFileSync(join(rootB, 'b.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [rootA],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      expect(recorder.watchers).toHaveLength(1)
      observation.setRoots([rootA, rootB])
      expect(recorder.watchers).toHaveLength(2)
      expect(observation.isObserving(rootB)).toBe(true)

      watcherAt(recorder, 1).emitChange('b.ts')
      await wait(40)
      expect(changes[0]?.root).toBe(resolve(rootB))

      observation.setRoots([rootB])
      expect(observation.isObserving(rootA)).toBe(false)
      expect(watcherAt(recorder, 0).closed).toBe(true)
      expect(observation.available).toBe(true)
    } finally {
      observation.dispose()
    }
  })

  it('非 Windows/macOS 平台逐目录监听并异步补齐子目录', async () => {
    const root = createTempRoot()
    const sourceDir = join(root, 'src')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'main.ts'), '')
    const changes: DirectoryObservationChange[] = []
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [root],
      debounceMs: 5,
      platform: 'linux',
      watchFactory: recorder.factory,
      onChange: (change) => changes.push(change),
    })

    try {
      expect(observation.mode).toBe('per-directory')
      await waitFor(() => recorder.watchers.length >= 2)

      const sourceWatcher = recorder.watchers.find((watcher) => watcher.path === resolve(sourceDir))
      expect(sourceWatcher).toBeDefined()
      sourceWatcher?.emitChange('main.ts')

      await wait(40)
      expect(changes[0]?.paths).toEqual([join(sourceDir, 'main.ts')])
    } finally {
      observation.dispose()
    }
  })

  it('根目录不存在时不建立监听并标记不可用', () => {
    const missingRoot = join(tmpdir(), `proma-missing-${Date.now()}`)
    const recorder = createRecorder()
    const observation = createDirectoryObservation({
      roots: [missingRoot],
      debounceMs: 5,
      platform: 'win32',
      watchFactory: recorder.factory,
      onChange: () => {},
    })

    try {
      expect(observation.available).toBe(false)
      expect(observation.isObserving(missingRoot)).toBe(false)
      expect(recorder.watchers).toHaveLength(0)
    } finally {
      observation.dispose()
    }
  })
})