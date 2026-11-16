/**
 * 有界异步查询缓存。
 *
 * 官方 0.22.0：用于 turn usage 等“同一 key 并发查询合并 + TTL + LRU 上限”的场景。
 * - 同 key 的并发请求只执行一次 loader；
 * - 结果按 TTL 缓存，超过 maxEntries 时淘汰最旧条目；
 * - clear() 会使排队中的请求立即失败，避免返回旧 generation 的结果。
 */

export interface BoundedAsyncLookupCacheOptions<T> {
  ttlMs: number
  maxEntries: number
  maxConcurrent: number
  shouldCache: (value: T) => boolean
}

interface QueueEntry<T> {
  key: string
  loader: () => Promise<T>
  generation: number
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

interface CachedValue<T> {
  value: T
  expiresAt: number
}

export class BoundedAsyncLookupCache<T> {
  private readonly cached = new Map<string, CachedValue<T>>()
  private readonly pending = new Map<string, Promise<T>>()
  private readonly queue: Array<QueueEntry<T>> = []
  private readonly activeByGeneration = new Map<number, number>()
  private generation = 0

  constructor(private readonly options: BoundedAsyncLookupCacheOptions<T>) {
    if (options.ttlMs <= 0 || options.maxEntries <= 0 || options.maxConcurrent <= 0) {
      throw new Error('lookup cache options must be positive')
    }
  }

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.cached.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      // 重新插入以刷新 LRU 顺序。
      this.cached.delete(key)
      this.cached.set(key, cached)
      return Promise.resolve(cached.value)
    }
    if (cached) this.cached.delete(key)

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const generation = this.generation
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ key, loader, generation, resolve, reject })
      this.drain()
    }).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    })
    this.pending.set(key, promise)
    return promise
  }

  clear(): void {
    this.generation += 1
    this.cached.clear()
    this.pending.clear()
    const error = new Error('agent turn usage lookup cache was cleared')
    while (this.queue.length) this.queue.shift()?.reject(error)
  }

  private drain(): void {
    while ((this.activeByGeneration.get(this.generation) ?? 0) < this.options.maxConcurrent && this.queue.length) {
      const lookup = this.queue.shift()
      if (!lookup) return
      const active = this.activeByGeneration.get(lookup.generation) ?? 0
      this.activeByGeneration.set(lookup.generation, active + 1)
      void lookup.loader()
        .then((value) => {
          if (lookup.generation === this.generation && this.options.shouldCache(value)) {
            this.cached.set(lookup.key, { value, expiresAt: Date.now() + this.options.ttlMs })
            while (this.cached.size > this.options.maxEntries) {
              const oldestKey = this.cached.keys().next().value
              if (oldestKey === undefined) break
              this.cached.delete(oldestKey)
            }
          }
          lookup.resolve(value)
        })
        .catch(lookup.reject)
        .finally(() => {
          const remaining = (this.activeByGeneration.get(lookup.generation) ?? 1) - 1
          if (remaining > 0) this.activeByGeneration.set(lookup.generation, remaining)
          else this.activeByGeneration.delete(lookup.generation)
          this.drain()
        })
    }
  }
}
