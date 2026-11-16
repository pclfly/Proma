import { describe, expect, test } from 'bun:test'
import { fileResolutionCacheKey, getFileName } from './file-path-chip-utils'

describe('文件 chip 解析 key', () => {
  test('Given 内容相同的不同数组 When 生成 key Then 完全一致，不触发重新解析', () => {
    const first = fileResolutionCacheKey('src/index.ts', ['/repo', '/repo/worktrees/a'], 'session-1')
    const second = fileResolutionCacheKey('src/index.ts', ['/repo', '/repo/worktrees/a'], 'session-1')

    expect(first).toBe(second)
  })

  test('Given 路径、候选目录或会话任一变化 When 生成 key Then 区分缓存', () => {
    const base = fileResolutionCacheKey('src/index.ts', ['/repo'], 'session-1')

    expect(fileResolutionCacheKey('src/other.ts', ['/repo'], 'session-1')).not.toBe(base)
    expect(fileResolutionCacheKey('src/index.ts', ['/repo/worktrees/a'], 'session-1')).not.toBe(base)
    expect(fileResolutionCacheKey('src/index.ts', ['/repo'], 'session-2')).not.toBe(base)
  })

  test('Given 分隔符容易混淆的路径 When 生成 key Then 不会发生前缀碰撞', () => {
    const left = fileResolutionCacheKey('a', ['b\0c'], undefined)
    const right = fileResolutionCacheKey('a\0b', ['c'], undefined)

    expect(left).not.toBe(right)
  })
})

describe('文件 chip 展示名', () => {
  test('Given Windows 绝对路径 When 取展示名 Then 只保留文件名', () => {
    expect(getFileName('C:\\Users\\me\\.proma\\attachments\\observations.csv')).toBe('observations.csv')
  })

  test('Given POSIX 路径或 UNC 路径 When 取展示名 Then 只保留文件名', () => {
    expect(getFileName('/Users/me/report.md')).toBe('report.md')
    expect(getFileName('\\\\server\\share\\report.md')).toBe('report.md')
  })

  test('Given 纯文件名或末尾带分隔符 When 取展示名 Then 不返回空字符串', () => {
    expect(getFileName('report.md')).toBe('report.md')
    // 末尾分隔符解析不到文件名，回退到原值，避免 chip 显示空文本。
    expect(getFileName('/Users/me/notes/')).toBe('/Users/me/notes/')
  })
})
