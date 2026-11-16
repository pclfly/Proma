import { describe, expect, test } from 'bun:test'
import type { TurnChangeEntry, TurnChangesSnapshot } from '@proma/shared'
import {
  TURN_GAP_THRESHOLD_MS,
  buildTurnStreamSections,
  countTurnChanges,
  filterTurnChanges,
  formatGapDuration,
  formatTurnClock,
  getTurnChangeStatusMeta,
  joinRootAndPath,
  summarizeTurnChanges,
} from './turn-changes-view'

function entry(filePath: string, overrides: Partial<TurnChangeEntry> = {}): TurnChangeEntry {
  return {
    filePath,
    rootPath: '/repo',
    status: 'modified',
    additions: 1,
    deletions: 0,
    diffAvailable: true,
    truncated: false,
    binary: false,
    tooLarge: false,
    symlink: false,
    baselineSource: 'file',
    updatedAt: 0,
    ...overrides,
  }
}

function turn(overrides: Partial<TurnChangesSnapshot> & { turnId: string }): TurnChangesSnapshot {
  const { turnId, ...rest } = overrides
  return {
    version: 1,
    sessionId: 's1',
    turnId,
    status: 'completed',
    startedAt: 1_000,
    finishedAt: 2_000,
    rootPath: '/repo',
    entries: [],
    filesChanged: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    ...rest,
  }
}

const streamOptions = { timeZone: 'Asia/Shanghai', locale: 'zh-CN' }

describe('turn-changes-view', () => {
  test('Given 没有任何轮次 When 构建改动流 Then 返回空数组', () => {
    expect(buildTurnStreamSections([])).toEqual([])
  })

  test('Given 同一轮修改多个文件 When 构建改动流 Then 只生成一段并把文件连在一起', () => {
    const snapshot = turn({
      turnId: '1',
      entries: [
        entry('src/a.ts', { additions: 3, deletions: 1 }),
        entry('src/b.ts', { status: 'created', additions: 5, deletions: 0 }),
      ],
      filesChanged: 2,
      totalAdditions: 8,
      totalDeletions: 1,
    })

    const sections = buildTurnStreamSections([snapshot], streamOptions)

    expect(sections).toHaveLength(1)
    expect(sections[0]?.turns).toHaveLength(1)
    expect(sections[0]?.turns[0]?.entries.map((item) => item.filePath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(sections[0]?.turns[0]?.summary).toMatchObject({ files: 2, additions: 8, deletions: 1 })
    expect(sections[0]?.turns[0]?.summary.text).toBe('2 个文件 · +8 -1')
    expect(sections[0]?.collapsible).toBe(false)
  })

  test('Given 两轮间隔超过 10 分钟 When 构建改动流 Then 拆成两段并标记可折叠区间', () => {
    const first = turn({
      turnId: '1',
      startedAt: 0,
      finishedAt: 60_000,
      entries: [entry('a.ts')],
    })
    const second = turn({
      turnId: '2',
      startedAt: 60_000 + TURN_GAP_THRESHOLD_MS + 60_000,
      finishedAt: 60_000 + TURN_GAP_THRESHOLD_MS + 120_000,
      entries: [entry('b.ts')],
    })

    const sections = buildTurnStreamSections([second, first], streamOptions)

    expect(sections).toHaveLength(2)
    expect(sections[0]?.key).toContain('turn:s1:1')
    expect(sections[0]?.gapMs).toBe(TURN_GAP_THRESHOLD_MS + 60_000)
    expect(sections[0]?.gapLabel).toBe('间隔 11 分钟')
    expect(sections[0]?.collapsible).toBe(true)
    expect(sections[0]?.collapsedByDefault).toBe(true)
    // 最新一段始终展开，不会被自己的间隔折叠。
    expect(sections[1]?.collapsible).toBe(false)
    expect(sections[1]?.collapsedByDefault).toBe(false)
  })

  test('Given 两轮间隔不超过阈值 When 构建改动流 Then 合并为一段且不折叠', () => {
    const first = turn({ turnId: '1', startedAt: 0, finishedAt: 60_000, entries: [entry('a.ts')] })
    const second = turn({ turnId: '2', startedAt: 120_000, finishedAt: 180_000, entries: [entry('b.ts')] })

    const sections = buildTurnStreamSections([first, second], streamOptions)

    expect(sections).toHaveLength(1)
    expect(sections[0]?.turns.map((item) => item.turn.turnId)).toEqual(['1', '2'])
    expect(sections[0]?.gapMs).toBe(0)
  })

  test('Given 停止轮次与空轮次 When 构建改动流 Then 保留已停止轮次并跳过无改动轮次', () => {
    const stopped = turn({
      turnId: '1',
      status: 'stopped',
      startedAt: 0,
      finishedAt: 1_000,
      entries: [entry('half.ts')],
    })
    const empty = turn({ turnId: '2', startedAt: 2_000, finishedAt: 3_000, entries: [] })

    const sections = buildTurnStreamSections([empty, stopped], streamOptions)

    expect(sections).toHaveLength(1)
    expect(sections[0]?.turns[0]?.statusLabel).toBe('已停止')
    expect(sections[0]?.turns[0]?.statusTone).toBe('stopped')
  })

  test('Given 搜索关键字 When 过滤 Then 仅保留命中文件与轮次', () => {
    const first = turn({ turnId: '1', entries: [entry('src/app.ts'), entry('README.md')] })
    const second = turn({ turnId: '2', entries: [entry('src/other.ts')] })

    const filtered = filterTurnChanges([first, second], 'APP')

    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.entries.map((item) => item.filePath)).toEqual(['src/app.ts'])
    expect(filterTurnChanges([first, second], '  ')[0]?.entries).toHaveLength(2)
  })

  test('Given 轮次集合 When 汇总 Then 统计轮次、文件与增删行数', () => {
    const turns = [
      turn({ turnId: '1', entries: [entry('a.ts', { additions: 2, deletions: 1 })] }),
      turn({ turnId: '2', entries: [entry('b.ts', { additions: 3, deletions: 0 }), entry('c.ts', { additions: 0, deletions: 4 })] }),
    ]

    expect(countTurnChanges(turns)).toEqual({ turns: 2, files: 3, additions: 5, deletions: 5 })
  })

  test('Given 间隔毫秒 When 格式化 Then 覆盖分钟、小时与天', () => {
    expect(formatGapDuration(30_000)).toBe('1 分钟')
    expect(formatGapDuration(25 * 60_000)).toBe('25 分钟')
    expect(formatGapDuration(2 * 60 * 60_000 + 15 * 60_000)).toBe('2 小时 15 分钟')
    expect(formatGapDuration(26 * 60 * 60_000)).toBe('1 天 2 小时')
  })

  test('Given 时间戳 When 格式化 Then 使用指定时区的 HH:mm', () => {
    // 2026-01-01T00:00:00Z = 08:00 Asia/Shanghai
    expect(formatTurnClock(Date.UTC(2026, 0, 1, 0, 0, 0), streamOptions)).toBe('08:00')
  })

  test('Given 文件状态 When 取展示元数据 Then 返回字母与中文标签', () => {
    expect(getTurnChangeStatusMeta('created')).toEqual({ label: '新增', letter: 'A', tone: 'created' })
    expect(getTurnChangeStatusMeta('modified')).toEqual({ label: '修改', letter: 'M', tone: 'modified' })
    expect(getTurnChangeStatusMeta('deleted')).toEqual({ label: '删除', letter: 'D', tone: 'deleted' })
  })

  test('Given 根目录与相对路径 When 拼接 Then 使用 POSIX 分隔符且不重复斜杠', () => {
    expect(joinRootAndPath('C:\\repo\\', 'src\\app.ts')).toBe('C:/repo/src/app.ts')
    expect(joinRootAndPath('/repo/', '/src/app.ts')).toBe('/repo/src/app.ts')
  })

  test('Given 单轮条目 When 生成摘要 Then 无行数变化时显示兜底文案', () => {
    expect(summarizeTurnChanges({ entries: [entry('img.png', { additions: 0, deletions: 0, binary: true })] }).text)
      .toBe('1 个文件 · 无行数变化')
  })
})
