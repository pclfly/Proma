import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listMarkdownFiles, searchMemory, tokenizeMemoryQuery } from './memory-search'

describe('记忆检索', () => {
  test('Given 英文与中文查询 When 分词 Then 英文按词、中文按二字组', () => {
    expect(tokenizeMemoryQuery('user preference')).toEqual(['user', 'preference'])
    expect(tokenizeMemoryQuery('用户偏好')).toEqual(['用户', '户偏', '偏好'])
  })

  test('Given 空查询 When 检索 Then 拒绝；纯符号返回空结果', () => {
    expect(() => searchMemory({ candidates: [], readContent: () => '' }, '   ')).toThrow('关键词')
    expect(searchMemory({ candidates: [], readContent: () => '' }, '!!!')).toEqual({
      query: '!!!',
      scannedFiles: 0,
      hits: [],
    })
  })

  test('Given 多个文件 When 检索 Then 标题加权、每个文件最多两条', () => {
    const files = new Map([
      ['/profile.md', '# 用户偏好\n普通内容 user preference\n另一条 user 记录\n第三条 user'],
      ['/memory/topic.md', '没有关键词'],
    ])
    const result = searchMemory({
      candidates: [
        { path: '/profile.md', label: 'user_profile.md' },
        { path: '/memory/topic.md', label: 'topic.md' },
      ],
      readContent: (path) => files.get(path),
    }, 'user', 10)
    expect(result.scannedFiles).toBe(2)
    expect(result.hits.length).toBeLessThanOrEqual(2)
    expect(result.hits.every((hit) => hit.path === '/profile.md')).toBe(true)
  })

  test('Given 超过 limit When 检索 Then 截断到上限', () => {
    const content = Array.from({ length: 10 }, (_, i) => `keyword line ${i}`).join('\n')
    const result = searchMemory({
      candidates: [{ path: '/a.md', label: 'a.md' }],
      readContent: () => content,
    }, 'keyword', 1)
    expect(result.hits).toHaveLength(1)
  })

  test('Given 记忆目录 When 列举 Then 跳过隐藏/归档目录并限制深度', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-memory-'))
    try {
      mkdirSync(join(root, 'topic'), { recursive: true })
      mkdirSync(join(root, '.hidden'), { recursive: true })
      mkdirSync(join(root, 'archive'), { recursive: true })
      writeFileSync(join(root, 'MEMORY.md'), '# index', 'utf8')
      writeFileSync(join(root, 'topic', 'a.md'), '# a', 'utf8')
      writeFileSync(join(root, '.hidden', 'b.md'), '# b', 'utf8')
      writeFileSync(join(root, 'archive', 'c.md'), '# c', 'utf8')
      const files = listMarkdownFiles(root)
      expect(files.some((file) => file.endsWith('MEMORY.md'))).toBe(true)
      expect(files.some((file) => file.endsWith('a.md'))).toBe(true)
      expect(files.some((file) => file.includes('.hidden'))).toBe(false)
      expect(files.some((file) => file.includes('archive'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
