import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentFileChangeTracker } from './agent-file-change-tracker'

const tempDirs: string[] = []

function createFixture(): {
  projectDir: string
  tracker: AgentFileChangeTracker
  snapshotsDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'proma-file-changes-'))
  const projectDir = join(root, 'project')
  const snapshotsDir = join(root, 'snapshots')
  mkdirSync(projectDir, { recursive: true })
  tempDirs.push(root)
  return {
    projectDir,
    snapshotsDir,
    tracker: new AgentFileChangeTracker(snapshotsDir),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('AgentFileChangeTracker', () => {
  test('Given 非 Git 文本文件，When Agent 修改文件，Then 返回会话基线 Diff', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'index.html')
    writeFileSync(filePath, 'red\n', 'utf-8')

    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, 'blue\nextra\n', 'utf-8')

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([
      expect.objectContaining({
        filePath: 'index.html',
        status: 'modified',
        additions: 2,
        deletions: 1,
        baseline: 'session',
      }),
    ])
    expect(tracker.getDiffContents('session-1', projectDir, 'index.html')).toEqual({
      oldContent: 'red\n',
      newContent: 'blue\nextra\n',
    })
  })

  test('Given 文件原本不存在，When Agent 新建文件，Then 标记为新增文件', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'new.txt')

    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, 'first\nsecond\n', 'utf-8')

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([
      expect.objectContaining({
        filePath: 'new.txt',
        status: 'untracked',
        additions: 2,
        deletions: 0,
        baseline: 'session',
      }),
    ])
  })

  test('Given 文件原本存在，When Agent 删除文件，Then 保留旧内容并标记删除', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'removed.txt')
    writeFileSync(filePath, 'first\nsecond\n', 'utf-8')

    await tracker.captureBaseline('session-1', filePath, projectDir)
    unlinkSync(filePath)

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([
      expect.objectContaining({
        filePath: 'removed.txt',
        status: 'deleted',
        additions: 0,
        deletions: 2,
        baseline: 'session',
      }),
    ])
    expect(tracker.getDiffContents('session-1', projectDir, 'removed.txt')).toEqual({
      oldContent: 'first\nsecond\n',
      newContent: '',
    })
  })

  test('Given 同一文件被多次写入，When 重建跟踪器，Then 仍使用首次写入前基线', async () => {
    const { projectDir, tracker, snapshotsDir } = createFixture()
    const filePath = join(projectDir, 'persisted.txt')
    writeFileSync(filePath, 'original\n', 'utf-8')

    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, 'middle\n', 'utf-8')
    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, 'final\n', 'utf-8')

    const restoredTracker = new AgentFileChangeTracker(snapshotsDir)
    expect(restoredTracker.getDiffContents('session-1', projectDir, 'persisted.txt')).toEqual({
      oldContent: 'original\n',
      newContent: 'final\n',
    })
  })

  test('Given 文件恢复为基线内容，When 获取改动，Then 不再显示该文件', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'restored.txt')
    writeFileSync(filePath, 'same\n', 'utf-8')

    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, 'changed\n', 'utf-8')
    writeFileSync(filePath, 'same\n', 'utf-8')

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([])
  })

  test('Given 写入工具已获准，When 执行写入，Then 在写入前建立文件基线', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'event.txt')
    writeFileSync(filePath, 'before\n', 'utf-8')
    await tracker.captureApprovedToolBaseline(
      'session-1',
      'Write',
      { file_path: filePath, content: 'after\n' },
      projectDir,
    )
    writeFileSync(filePath, 'after\n', 'utf-8')

    expect(tracker.getDiffContents('session-1', projectDir, 'event.txt')).toEqual({
      oldContent: 'before\n',
      newContent: 'after\n',
    })
  })

  test('Given 工具未进入批准采集路径，When 文件被外部修改，Then 不记录会话改动', () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'denied.txt')
    writeFileSync(filePath, 'before\n', 'utf-8')

    writeFileSync(filePath, 'after\n', 'utf-8')

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([])
  })

  test('Given Diff 请求路径位于显示根目录外，When 读取内容，Then 拒绝目录越界', async () => {
    const { projectDir, tracker } = createFixture()
    const outsidePath = join(projectDir, '..', 'outside.txt')
    writeFileSync(outsidePath, 'before\n', 'utf-8')
    await tracker.captureBaseline('session-1', outsidePath, projectDir)
    writeFileSync(outsidePath, 'after\n', 'utf-8')

    expect(tracker.getDiffContents('session-1', projectDir, outsidePath)).toBeNull()
  })

  test('Given 基线文件随后变为二进制，When 获取改动，Then 保留不可预览条目', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'binary.dat')
    writeFileSync(filePath, 'before\n', 'utf-8')
    await tracker.captureBaseline('session-1', filePath, projectDir)
    writeFileSync(filePath, Buffer.from([0, 1, 2, 3]))

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([
      expect.objectContaining({
        filePath: 'binary.dat',
        status: 'modified',
        additions: 0,
        deletions: 0,
        previewable: false,
      }),
    ])
    expect(tracker.getDiffContents('session-1', projectDir, 'binary.dat')).toBeNull()
  })

  test('Given 二进制文件内容未变化，When 工具执行失败或未写入，Then 不产生假改动', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'unchanged.dat')
    writeFileSync(filePath, Buffer.from([0, 1, 2, 3]))

    await tracker.captureApprovedToolBaseline('session-1', 'Write', { file_path: filePath }, projectDir)

    expect(tracker.getChanges('session-1', [projectDir])).toEqual([])
  })

  test('Given Bash 通过重定向修改文件，When 请求采集，Then 建立目标文件基线', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'script-output.txt')
    writeFileSync(filePath, 'before\n', 'utf-8')

    await tracker.captureApprovedToolBaseline(
      'session-1',
      'Bash',
      { command: `echo after > "${filePath}"` },
      projectDir,
      { captureBashTargets: true },
    )
    writeFileSync(filePath, 'after\n', 'utf-8')

    expect(tracker.getDiffContents('session-1', projectDir, 'script-output.txt')).toEqual({
      oldContent: 'before\n',
      newContent: 'after\n',
    })
  })

  test('Given Bash 运行脚本修改相邻文件，When 脚本包含目标路径，Then 提前建立目标基线', async () => {
    const { projectDir, tracker } = createFixture()
    const filePath = join(projectDir, 'data.txt')
    const scriptPath = join(projectDir, 'update.py')
    writeFileSync(filePath, 'before\n', 'utf-8')
    writeFileSync(scriptPath, "open('data.txt', 'w').write('after\\n')\n", 'utf-8')

    await tracker.captureApprovedToolBaseline(
      'session-1',
      'Bash',
      { command: `python "${scriptPath}"` },
      projectDir,
      { captureBashTargets: true },
    )
    writeFileSync(filePath, 'after\n', 'utf-8')

    expect(tracker.getDiffContents('session-1', projectDir, 'data.txt')).toEqual({
      oldContent: 'before\n',
      newContent: 'after\n',
    })
  })

  test('Given 会话删除时存在待采集任务，When 清理会话，Then 快照目录不会复活', async () => {
    const { projectDir, snapshotsDir, tracker } = createFixture()
    const filePath = join(projectDir, 'pending.txt')
    writeFileSync(filePath, 'before\n', 'utf-8')

    const capture = tracker.captureApprovedToolBaseline(
      'session-1',
      'Write',
      { file_path: filePath },
      projectDir,
    )
    tracker.clearSession('session-1')
    await capture

    expect(existsSync(join(snapshotsDir, 'session-1'))).toBe(false)
  })
})
