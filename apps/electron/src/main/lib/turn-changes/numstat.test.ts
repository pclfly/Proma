import { describe, expect, test } from 'bun:test'
import { parseGitNumstat } from './numstat'

describe('parseGitNumstat', () => {
  test('Given 普通修改 When 解析 -z 输出 Then 返回文件与增删行数', () => {
    expect(parseGitNumstat('3\t1\tsrc/app.ts\0')).toEqual([
      { filePath: 'src/app.ts', additions: 3, deletions: 1, binary: false },
    ])
  })

  test('Given 二进制文件 When 行数字段为 - Then 标记 binary 并归零计数', () => {
    expect(parseGitNumstat('-\t-\tassets/logo.png\0')).toEqual([
      { filePath: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
    ])
  })

  test('Given 重命名条目 When 解析 Then 跳过旧路径字段并使用新路径', () => {
    expect(parseGitNumstat('1\t0\t\0old.txt\0dir/new.txt\0')).toEqual([
      { filePath: 'dir/new.txt', additions: 1, deletions: 0, binary: false },
    ])
  })

  test('Given 含空格文件与多条记录 When 解析 Then 全部保留且路径正常', () => {
    expect(parseGitNumstat('2\t0\tmy file.md\0')).toEqual([
      { filePath: 'my file.md', additions: 2, deletions: 0, binary: false },
    ])
    expect(parseGitNumstat('1\t0\ta.ts\0' + '2\t3\tb.ts\0')).toHaveLength(2)
  })

  test('Given 空输出或损坏条目 When 解析 Then 返回空数组', () => {
    expect(parseGitNumstat('')).toEqual([])
    expect(parseGitNumstat('garbage\0')).toEqual([])
  })
})
