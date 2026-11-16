import { describe, expect, test } from 'bun:test'
import { BoundedAsyncLookupCache } from './agent-turn-usage-cache'

function cache<T>(overrides: Partial<{ ttlMs: number; maxEntries: number; maxConcurrent: number; shouldCache: (value: T) => boolean }> = {}) {
  return new BoundedAsyncLookupCache<T>({
    ttlMs: 60_000,
    maxEntries: 2,
    maxConcurrent: 2,
    shouldCache: () => true,
    ...overrides,
  })
}

describe('有界异步查询缓存', () => {
  test('Given 非法参数 When 构造 Then 拒绝', () => {
    expect(() => cache({ ttlMs: 0 })).toThrow()
    expect(() => cache({ maxEntries: 0 })).toThrow()
    expect(() => cache({ maxConcurrent: 0 })).toThrow()
  })

  test('Given 同 key 并发 When 查询 Then loader 只执行一次并共享结果', async () => {
    let loads = 0
    const lookup = cache<number>()
    const loader = async () => {
      loads += 1
      return 42
    }
    const [a, b] = await Promise.all([
      lookup.getOrLoad('k', loader),
      lookup.getOrLoad('k', loader),
    ])
    expect(a).toBe(42)
    expect(b).toBe(42)
    expect(loads).toBe(1)
    // 缓存命中后不再执行 loader。
    expect(await lookup.getOrLoad('k', loader)).toBe(42)
    expect(loads).toBe(1)
  })

  test('Given shouldCache=false When 查询 Then 每次都重新加载', async () => {
    let loads = 0
    const lookup = cache<number>({ shouldCache: () => false })
    const loader = async () => {
      loads += 1
      return loads
    }
    expect(await lookup.getOrLoad('k', loader)).toBe(1)
    expect(await lookup.getOrLoad('k', loader)).toBe(2)
    expect(loads).toBe(2)
  })

  test('Given 超过 maxEntries When 插入 Then 淘汰最旧 key', async () => {
    let loads = 0
    const lookup = cache<string>({ maxEntries: 2 })
    const loader = async (value: string) => {
      loads += 1
      return value
    }
    await lookup.getOrLoad('a', () => loader('a'))
    await lookup.getOrLoad('b', () => loader('b'))
    await lookup.getOrLoad('c', () => loader('c'))
    await lookup.getOrLoad('a', () => loader('a'))
    expect(loads).toBe(4)
  })

  test('Given 排队中的请求 When clear Then 立即拒绝且不执行 loader', async () => {
    let release!: (value: string) => void
    const first = new Promise<string>((resolve) => { release = resolve })
    const lookup = cache<string>({ maxConcurrent: 1 })
    const running = lookup.getOrLoad('a', () => first)
    const queued = lookup.getOrLoad('b', async () => 'b')
    lookup.clear()
    await expect(queued).rejects.toThrow('cleared')
    release('a')
    await expect(running).resolves.toBe('a')
  })
})
