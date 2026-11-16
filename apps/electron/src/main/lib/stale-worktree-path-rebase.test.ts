import { describe, expect, test } from 'bun:test'
import {
  isCaseInsensitivePlatform,
  normalizeCheckoutPathForCompare,
} from './session-checkout'
import { rebaseStaleWorktreeRecord, type StaleWorktreeRecord } from './stale-worktree-path-rebase'

function staleRecord(overrides: Partial<StaleWorktreeRecord> = {}): StaleWorktreeRecord {
  return {
    path: '/repos/main-worktrees/old-feature',
    repositoryRoot: '/repos/main',
    branch: 'feature',
    ...overrides,
  }
}

describe('失效 Worktree 路径重定位', () => {
  test('Given 唯一同仓库同分支候选 When 重定位 Then 改写为新路径', () => {
    const result = rebaseStaleWorktreeRecord(staleRecord(), [
      { path: '/repos/main-worktrees/feature-2', branch: 'feature' },
    ])

    expect(result.rebased).toBe(true)
    expect(result.ambiguous).toBe(false)
    expect(result.candidates).toEqual([])
    expect(result.record).toEqual({
      path: '/repos/main-worktrees/feature-2',
      repositoryRoot: '/repos/main',
      branch: 'feature',
    })
  })

  test('Given 候选路径与记录相同 When 重定位 Then 视为未变更并保留原记录对象', () => {
    const record = staleRecord({ path: '/repos/main-worktrees/feature' })

    const result = rebaseStaleWorktreeRecord(record, [
      { path: '/repos/main-worktrees/feature', branch: 'feature' },
    ])

    expect(result.rebased).toBe(false)
    expect(result.ambiguous).toBe(false)
    expect(result.record).toBe(record)
  })

  test('Given 两个同仓库同分支候选 When 重定位 Then 判定 ambiguous 且不猜测', () => {
    const record = staleRecord()

    const result = rebaseStaleWorktreeRecord(record, [
      { path: '/repos/main-worktrees/a', branch: 'feature' },
      { path: '/repos/main-worktrees/b', branch: 'feature' },
    ])

    expect(result.rebased).toBe(false)
    expect(result.ambiguous).toBe(true)
    expect(result.record).toBe(record)
    expect(result.candidates).toEqual([
      '/repos/main-worktrees/a',
      '/repos/main-worktrees/b',
    ])
  })

  test('Given 两个候选指向同一路径 When 重定位 Then 不算 ambiguous', () => {
    const result = rebaseStaleWorktreeRecord(staleRecord(), [
      { path: '/repos/main-worktrees/feature-2', branch: 'feature' },
      { path: '/repos/main-worktrees/feature-2/', branch: 'feature' },
    ])

    expect(result.ambiguous).toBe(false)
    expect(result.rebased).toBe(true)
    expect(result.record.path).toBe('/repos/main-worktrees/feature-2')
  })

  test('Given 候选分支不同、是主 worktree 或属于其它仓库 When 重定位 Then 不匹配', () => {
    const result = rebaseStaleWorktreeRecord(staleRecord(), [
      { path: '/repos/main-worktrees/other-branch', branch: 'other' },
      { path: '/repos/main', branch: 'feature', isMain: true },
      {
        path: '/other/wt/feature',
        branch: 'feature',
        repositoryRoot: '/repos/other',
      },
    ])

    expect(result.rebased).toBe(false)
    expect(result.ambiguous).toBe(false)
    expect(result.candidates).toEqual([])
  })

  test('Given 记录缺少分支或仓库根 When 重定位 Then 原样返回', () => {
    const missingBranch = rebaseStaleWorktreeRecord(
      staleRecord({ branch: undefined }),
      [{ path: '/repos/main-worktrees/feature-2', branch: 'feature' }],
    )
    const missingRoot = rebaseStaleWorktreeRecord(
      staleRecord({ repositoryRoot: undefined }),
      [{ path: '/repos/main-worktrees/feature-2', branch: 'feature' }],
    )

    expect(missingBranch.rebased).toBe(false)
    expect(missingRoot.rebased).toBe(false)
  })

  test('Given 候选按大小写不敏感比较 When 仓库根写法不同 Then 仍可匹配', () => {
    const result = rebaseStaleWorktreeRecord(
      {
        path: 'C:\\Repos\\Main-Worktrees\\Old',
        repositoryRoot: 'C:\\Repos\\Main',
        branch: 'feature',
      },
      [{
        path: 'C:\\Repos\\Main-Worktrees\\New',
        branch: 'feature',
        repositoryRoot: 'C:/repos/main',
      }],
      { caseInsensitive: true },
    )

    expect(result.rebased).toBe(true)
    expect(result.record.path).toBe('C:\\Repos\\Main-Worktrees\\New')
  })

  test('Given 大小写敏感比较 When 仓库根仅大小写不同 Then 不匹配', () => {
    const result = rebaseStaleWorktreeRecord(
      staleRecord(),
      [{
        path: '/repos/main-worktrees/feature-2',
        branch: 'feature',
        repositoryRoot: '/REPOS/MAIN',
      }],
      { caseInsensitive: false },
    )

    expect(result.rebased).toBe(false)
  })

  test('Given 记录与候选仅分隔符不同 When 去重 Then 视为同一路径', () => {
    const result = rebaseStaleWorktreeRecord(
      { path: 'C:\\Repos\\Main-Worktrees\\Feature', repositoryRoot: 'C:\\Repos\\Main', branch: 'feature' },
      [{ path: 'C:/repos/main-worktrees/feature/', branch: 'feature' }],
      { caseInsensitive: true },
    )

    expect(result.rebased).toBe(false)
    expect(result.ambiguous).toBe(false)
  })
})

describe('Worktree 路径平台归一', () => {
  test('Given Windows 分隔符与大小写差 When 归一 Then 按平台策略输出比较键', () => {
    expect(normalizeCheckoutPathForCompare('C:\\Repos\\WT\\Feature\\', true))
      .toBe('c:/repos/wt/feature')
    expect(normalizeCheckoutPathForCompare('C:\\Repos\\WT', false)).toBe('C:/Repos/WT')
  })

  test('Given 不存在的相对路径 When 归一 Then 不 resolve 到磁盘位置', () => {
    expect(normalizeCheckoutPathForCompare('../missing-worktree', false)).toBe('../missing-worktree')
  })

  test('Given 平台 When 判断大小写敏感性 Then 与平台一致', () => {
    expect(isCaseInsensitivePlatform('win32')).toBe(true)
    expect(isCaseInsensitivePlatform('darwin')).toBe(true)
    expect(isCaseInsensitivePlatform('linux')).toBe(false)
  })
})
