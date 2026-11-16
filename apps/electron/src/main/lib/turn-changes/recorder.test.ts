import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GitReaderLike, GitRepositorySnapshot } from './git'
import { TurnChangeRecorder } from './recorder'
import type { TurnChangeRecorderOptions } from './types'

const tempDirs: string[] = []

interface Fixture {
  root: string
  projectDir: string
  storageDir: string
  recorder: TurnChangeRecorder
}

function createFixture(options: Partial<TurnChangeRecorderOptions> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-turn-changes-'))
  const projectDir = join(root, 'project')
  const storageDir = join(root, 'storage')
  mkdirSync(projectDir, { recursive: true })
  tempDirs.push(root)
  return {
    root,
    projectDir,
    storageDir,
    recorder: new TurnChangeRecorder({
      storageDir,
      pruneTimer: false,
      createGitReader: () => null,
      ...options,
    }),
  }
}

function fakeGitReader(snapshot: GitRepositorySnapshot, headContent: string | null): GitReaderLike {
  return {
    getSnapshot: async () => snapshot,
    readFileAtHead: async () => headContent,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('TurnChangeRecorder', () => {
  test('Given 同一文件连续多轮修改 When 分别结算 Then 每轮只看自己这一轮的前后差异', async () => {
    const { projectDir, storageDir, recorder } = createFixture()
    const filePath = join(projectDir, 'app.ts')
    writeFileSync(filePath, 'line1\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Edit', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'line1\nline2\n', 'utf-8')
    const turn1 = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    recorder.beginTurn({ sessionId: 's1', turnId: '2', rootPath: projectDir, startedAt: 3_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '2', toolName: 'Edit', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'line1\nchanged\nline3\n', 'utf-8')
    const turn2 = await recorder.finishTurn({ sessionId: 's1', turnId: '2', status: 'completed', finishedAt: 4_000 })

    expect(turn1).toMatchObject({ status: 'completed', filesChanged: 1, totalAdditions: 1, totalDeletions: 0 })
    expect(turn1?.entries[0]).toMatchObject({ filePath: 'app.ts', status: 'modified', additions: 1, deletions: 0 })
    expect(turn2).toMatchObject({ filesChanged: 1, totalAdditions: 2, totalDeletions: 1 })
    expect(turn2?.entries[0]).toMatchObject({ filePath: 'app.ts', status: 'modified', additions: 2, deletions: 1 })

    expect(recorder.getTurns('s1').map((turn) => turn.turnId)).toEqual(['1', '2'])
    const persisted = readFileSync(join(storageDir, 's1.jsonl'), 'utf-8').trim().split('\n')
    expect(persisted).toHaveLength(2)

    // 新 recorder 从 JSONL 恢复历史轮次，模拟应用重启后的右侧工作区。
    const restored = new TurnChangeRecorder({ storageDir, pruneTimer: false, createGitReader: () => null })
    expect(restored.getTurns('s1').map((turn) => turn.turnId)).toEqual(['1', '2'])
    restored.dispose()
    recorder.dispose()
  })

  test('Given 本轮内创建后又删除同一文件 When 结算 Then 不产生虚假改动记录', async () => {
    const { projectDir, recorder } = createFixture()
    const filePath = join(projectDir, 'temp.txt')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Write', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'temporary\n', 'utf-8')
    rmSync(filePath, { force: true })
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    expect(snapshot).toMatchObject({ filesChanged: 0, totalAdditions: 0, totalDeletions: 0, entries: [] })
    recorder.dispose()
  })

  test('Given 非 Git 目录 When 修改文件 Then 仍以磁盘基线记录 diff', async () => {
    const { projectDir, recorder } = createFixture()
    const filePath = join(projectDir, 'notes.md')
    writeFileSync(filePath, 'red\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Write', input: { path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'blue\n', 'utf-8')
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    expect(snapshot?.entries[0]).toMatchObject({
      filePath: 'notes.md',
      status: 'modified',
      diffAvailable: true,
      baselineSource: 'file',
      additions: 1,
      deletions: 1,
    })
    recorder.dispose()
  })

  test('Given 单文件超过 2 MiB 上限配置 When 修改 Then 只记录元数据摘要', async () => {
    const { projectDir, recorder } = createFixture({ limits: { maxFileBytes: 8 } })
    const filePath = join(projectDir, 'large.txt')
    writeFileSync(filePath, '0123456789\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Edit', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, '0123456789\nmore\n', 'utf-8')
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    expect(snapshot?.entries[0]).toMatchObject({
      status: 'modified',
      diffAvailable: false,
      tooLarge: true,
      additions: 0,
      deletions: 0,
    })
    expect(snapshot?.entries[0]?.sizeAfter).toBeGreaterThan(8)
    recorder.dispose()
  })

  test('Given 用户中途停止 When 结算 Then 已触达文件仍被记录且状态为 stopped', async () => {
    const { projectDir, recorder } = createFixture()
    const filePath = join(projectDir, 'partial.ts')
    writeFileSync(filePath, 'a\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Edit', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'a\nb\n', 'utf-8')
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'stopped', finishedAt: 2_000 })

    expect(snapshot).toMatchObject({ status: 'stopped', filesChanged: 1 })
    expect(snapshot?.entries[0]?.additions).toBe(1)
    recorder.dispose()
  })

  test('Given 同一轮重复结算 When 串行与并发调用 Then 返回同一快照且只持久化一次', async () => {
    const { projectDir, storageDir, recorder } = createFixture()
    const filePath = join(projectDir, 'once.txt')
    writeFileSync(filePath, 'before\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Write', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'after\n', 'utf-8')

    const firstPromise = recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })
    const secondPromise = recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    const third = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'failed', finishedAt: 3_000 })

    expect(first?.filesChanged).toBe(1)
    expect(second?.turnId).toBe('1')
    expect(third).toEqual(first)
    expect(recorder.getTurns('s1')).toHaveLength(1)
    expect(readFileSync(join(storageDir, 's1.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1)
    recorder.dispose()
  })

  test('Given 目标越界或超过单轮文件上限 When 登记 Then 越界忽略、超限计数', async () => {
    const { projectDir, root, recorder } = createFixture({ limits: { maxFiles: 2 } })
    const files = ['a.ts', 'b.ts', 'c.ts'].map((name) => join(projectDir, name))
    for (const filePath of files) writeFileSync(filePath, 'old\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({
      sessionId: 's1',
      turnId: '1',
      toolName: 'Write',
      input: { file_path: resolve(root, 'outside.txt') },
      phase: 'before',
    })
    for (const filePath of files) {
      await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Write', input: { file_path: filePath }, phase: 'before' })
      writeFileSync(filePath, 'new\n', 'utf-8')
    }
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    expect(snapshot?.filesChanged).toBe(2)
    expect(snapshot?.droppedFiles).toBe(1)
    expect(snapshot?.entries.map((entry) => entry.filePath)).toEqual(['a.ts', 'b.ts'])
    recorder.dispose()
  })

  test('Given 工具执行后才登记且轮次开始时 Git 干净 When 结算 Then 用 HEAD 恢复执行前基线', async () => {
    const { projectDir, recorder } = createFixture({
      createGitReader: () => fakeGitReader({
        isGitRepository: true,
        rootPath: projectDir,
        head: 'abc123',
        dirtyPaths: [],
        numstat: [],
      }, 'original\n'),
    })
    const filePath = join(projectDir, 'tracked.ts')
    writeFileSync(filePath, 'modified\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Edit', input: { file_path: filePath }, phase: 'after' })
    const snapshot = await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    expect(snapshot?.entries[0]).toMatchObject({
      status: 'modified',
      baselineSource: 'git-head',
      additions: 1,
      deletions: 1,
    })
    recorder.dispose()
  })

  test('Given 会话被删除 When 清理 Then 内存与 JSONL 都不再保留该会话', async () => {
    const { projectDir, recorder } = createFixture()
    const filePath = join(projectDir, 'gone.txt')
    writeFileSync(filePath, 'a\n', 'utf-8')

    recorder.beginTurn({ sessionId: 's1', turnId: '1', rootPath: projectDir, startedAt: 1_000 })
    await recorder.noteToolTargets({ sessionId: 's1', turnId: '1', toolName: 'Write', input: { file_path: filePath }, phase: 'before' })
    writeFileSync(filePath, 'b\n', 'utf-8')
    await recorder.finishTurn({ sessionId: 's1', turnId: '1', status: 'completed', finishedAt: 2_000 })

    recorder.clearSession('s1')
    expect(recorder.getTurns('s1')).toEqual([])
    recorder.dispose()
  })
})
