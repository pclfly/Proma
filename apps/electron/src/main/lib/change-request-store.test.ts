/**
 * 变更请求绑定存储测试
 *
 * 覆盖：跨会话隔离、URL 去重、仓库过滤、状态快照/错误落盘、隐藏、上限与损坏文件降级。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChangeRequestSnapshot } from '@proma/shared'
import { ChangeRequestStore } from './change-request-store'

const tempDirs: string[] = []

function createStore(): { store: ChangeRequestStore; filePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'proma-change-request-store-'))
  tempDirs.push(root)
  const filePath = join(root, 'change-requests.json')
  return { store: new ChangeRequestStore(filePath), filePath }
}

function snapshot(overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    title: '示例 PR',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature/login',
    baseRefName: 'main',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    checks: [],
    fetchedAt: 1,
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ChangeRequestStore', () => {
  test('Given 两个会话各自绑定不同仓库的 PR，When 分别读取，Then 绑定互不串台', () => {
    const { store } = createStore()
    const repoOne = 'https://github.com/acme/one/pull/1'
    const repoTwo = 'https://github.com/acme/two/pull/1'

    store.merge('session-a', [repoOne], 'discovered')
    store.merge('session-b', [repoTwo], 'discovered')

    expect(store.list('session-a').map((binding) => binding.url)).toEqual([repoOne])
    expect(store.list('session-b').map((binding) => binding.url)).toEqual([repoTwo])
    expect(store.list('session-a')[0]?.repo).toBe('one')
    expect(store.list('session-b')[0]?.repo).toBe('two')
  })

  test('Given 同一 PR 被重复观察，When 多次合并，Then 只保留一条绑定', () => {
    const { store } = createStore()
    const url = 'https://github.com/acme/repo/pull/42'

    expect(store.merge('session-a', [url, url], 'discovered').changed).toBe(true)
    expect(store.merge('session-a', [url], 'referenced').changed).toBe(false)
    expect(store.list('session-a')).toHaveLength(1)
  })

  test('Given 链接指向其它仓库，When accept 拒绝，Then 不写入任何绑定', () => {
    const { store } = createStore()
    const accept = (url: string) => url.includes('/acme/repo/')

    const result = store.merge(
      'session-a',
      ['https://github.com/other/repo/pull/1', 'https://github.com/acme/repo/pull/2'],
      'discovered',
      accept,
    )

    expect(result.changed).toBe(true)
    expect(result.bindings.map((binding) => binding.url)).toEqual(['https://github.com/acme/repo/pull/2'])
  })

  test('Given 已保存快照，When 重新打开文件，Then 状态与 fetchedAt 都能恢复', () => {
    const { store, filePath } = createStore()
    const url = 'https://github.com/acme/repo/pull/7'
    store.merge('session-a', [url], 'discovered')
    store.setSnapshot('session-a', url, snapshot({ title: '修复登录', fetchedAt: 10 }), 20)

    const reopened = new ChangeRequestStore(filePath)
    const binding = reopened.list('session-a')[0]

    expect(binding?.snapshot?.title).toBe('修复登录')
    expect(binding?.fetchedAt).toBe(20)
    expect(binding?.error).toBeUndefined()
  })

  test('Given 读取失败，When 记录错误后再成功，Then 成功后清空错误', () => {
    const { store } = createStore()
    const url = 'https://github.com/acme/repo/pull/9'
    store.merge('session-a', [url], 'discovered')

    expect(store.setError('session-a', url, 'gh 未登录')).toBe(true)
    expect(store.setError('session-a', url, 'gh 未登录')).toBe(false)
    expect(store.list('session-a')[0]?.error).toBe('gh 未登录')

    store.setSnapshot('session-a', url, snapshot())
    expect(store.list('session-a')[0]?.error).toBeUndefined()
  })

  test('Given 用户隐藏一条绑定，When 读取订阅会话，Then 记录保留但不再计入轮询', () => {
    const { store } = createStore()
    const url = 'https://github.com/acme/repo/pull/3'
    store.merge('session-a', [url], 'discovered')

    const result = store.dismiss('session-a', url)

    expect(result.changed).toBe(true)
    expect(store.list('session-a')[0]?.dismissed).toBe(true)
    expect(store.listBoundSessions()).toEqual([])
  })

  test('Given 会话被删除，When removeSession，Then 该会话绑定全部消失', () => {
    const { store } = createStore()
    store.merge('session-a', ['https://github.com/acme/repo/pull/1'], 'discovered')
    store.merge('session-b', ['https://github.com/acme/repo/pull/2'], 'discovered')

    expect(store.removeSession('session-a')).toBe(true)
    expect(store.list('session-a')).toEqual([])
    expect(store.listBoundSessions()).toEqual(['session-b'])
  })

  test('Given 单会话绑定超过上限，When 继续合并，Then 只保留最近的上限条数', () => {
    const { store } = createStore()
    const urls = Array.from({ length: 25 }, (_, index) => `https://github.com/acme/repo/pull/${index + 1}`)

    store.merge('session-a', urls, 'discovered')

    const bindings = store.list('session-a')
    expect(bindings).toHaveLength(20)
    expect(bindings[0]?.number).toBe(6)
    expect(bindings.at(-1)?.number).toBe(25)
  })

  test('Given 绑定文件损坏，When 读取，Then 按空数据继续且不抛异常', () => {
    const { store, filePath } = createStore()
    writeFileSync(filePath, '{ not json', 'utf-8')

    expect(store.list('session-a')).toEqual([])
    expect(store.listBoundSessions()).toEqual([])
  })

  test('Given 文件里混入非法链接，When 读取，Then 只保留可解析的绑定', () => {
    const { filePath } = createStore()
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      sessions: {
        'session-a': {
          updatedAt: 1,
          bindings: [
            { url: 'https://github.com/acme/repo/pull/5', source: 'discovered', createdAt: 1 },
            { url: 'https://evil.example/acme/repo/issues/5', source: 'discovered', createdAt: 1 },
            { url: 'not-a-url', source: 'discovered', createdAt: 1 },
          ],
        },
      },
    }), 'utf-8')

    const store = new ChangeRequestStore(filePath)
    expect(store.list('session-a').map((binding) => binding.number)).toEqual([5])
  })
})
