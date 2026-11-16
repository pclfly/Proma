import { describe, expect, test } from 'bun:test'
import type { CapturedFileSnapshot } from './capture'
import { compareSnapshots } from './compare'

const rootPath = '/repo'

function text(content: string): CapturedFileSnapshot {
  return { kind: 'text', signature: `text:${content}`, size: Buffer.byteLength(content), text: content }
}

const missing: CapturedFileSnapshot = { kind: 'missing', signature: 'missing' }

describe('compareSnapshots', () => {
  test('Given 文件原本不存在 When 新建文件 Then 标记为 created 并给出新增行', () => {
    const entry = compareSnapshots({
      rootPath,
      filePath: 'src/new.ts',
      before: missing,
      after: text('export const a = 1\nexport const b = 2\n'),
      changedAt: 100,
    })

    expect(entry).toMatchObject({
      status: 'created',
      filePath: 'src/new.ts',
      rootPath,
      additions: 2,
      deletions: 0,
      diffAvailable: true,
      binary: false,
      tooLarge: false,
    })
    expect(entry?.hunks?.[0]?.added.map((line) => line.text)).toEqual([
      'export const a = 1',
      'export const b = 2',
    ])
  })

  test('Given 文件被改写 When 比较前后快照 Then 返回 modified 与 hunk 增删明细', () => {
    const entry = compareSnapshots({
      rootPath,
      filePath: 'README.md',
      before: text('# 标题\n旧内容\n'),
      after: text('# 标题\n新内容\n追加\n'),
      changedAt: 200,
    })

    expect(entry?.status).toBe('modified')
    expect(entry?.additions).toBe(2)
    expect(entry?.deletions).toBe(1)
    expect(entry?.preview).toBe('新内容')
    expect(entry?.hunks?.[0]?.removed.map((line) => line.text)).toEqual(['旧内容'])
    expect(entry?.hunks?.[0]?.added.map((line) => line.text)).toEqual(['新内容', '追加'])
  })

  test('Given 文件被删除 When 比较前后快照 Then 标记为 deleted', () => {
    const entry = compareSnapshots({
      rootPath,
      filePath: 'old.txt',
      before: text('a\nb\n'),
      after: missing,
      changedAt: 300,
    })

    expect(entry).toMatchObject({ status: 'deleted', additions: 0, deletions: 2, diffAvailable: true })
  })

  test('Given 前后签名一致 When 比较 Then 返回 null（本轮未改动）', () => {
    expect(compareSnapshots({
      rootPath,
      filePath: 'same.txt',
      before: text('same\n'),
      after: text('same\n'),
      changedAt: 400,
    })).toBeNull()
  })

  test('Given 超出 diff 体积上限的文本 When 比较 Then 只给摘要不生成 hunk', () => {
    const entry = compareSnapshots({
      rootPath,
      filePath: 'big.log',
      before: { kind: 'text', signature: 'text:big-1', size: 400 * 1024, text: 'a\n' },
      after: { kind: 'text', signature: 'text:big-2', size: 500 * 1024, text: 'b\n' },
      changedAt: 500,
    })

    expect(entry).toMatchObject({
      status: 'modified',
      diffAvailable: false,
      truncated: true,
      additions: 0,
      deletions: 0,
      sizeAfter: 500 * 1024,
    })
    expect(entry?.hunks).toBeUndefined()
  })

  test('Given 二进制文件 When 比较 Then 不尝试文本 diff', () => {
    const entry = compareSnapshots({
      rootPath,
      filePath: 'logo.png',
      before: { kind: 'binary', signature: 'binary:a', size: 10 },
      after: { kind: 'binary', signature: 'binary:b', size: 20 },
      changedAt: 600,
    })

    expect(entry).toMatchObject({ binary: true, diffAvailable: false, additions: 0, deletions: 0 })
  })
})
