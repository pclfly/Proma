import type { VaultDirectoryListing, VaultFileEntry, VaultTreeEntry } from '@proma/shared'
import { getVaultFolderAncestors } from './vault-tree-model'

export interface VaultDirectorySnapshot {
  vaultId: string | null
  directories: ReadonlyMap<string, readonly VaultTreeEntry[]>
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  expandingAll: boolean
}

export type VaultDirectoryLoader = (vaultId: string, relativePath: string, offset: number) => Promise<VaultDirectoryListing>

/**
 * 目录缓存和用户展开状态分离。所有异步提交都校验库身份/epoch；请求只填缓存，
 * 不能在用户已经折叠后重新打开目录。刷新仅重读已加载层，切库丢弃旧结果。
 */
export class VaultDirectoryController {
  private snapshot: VaultDirectorySnapshot = {
    vaultId: null, directories: new Map(), expanded: new Set(), loading: new Set(), errors: new Map(), expandingAll: false,
  }
  private epoch = 0
  private navigation = 0
  private revealPath: string | null = null
  private readonly listeners = new Set<() => void>()
  private pending = new Map<string, Promise<boolean>>()

  constructor(private readonly loader: VaultDirectoryLoader) {}

  getSnapshot = (): VaultDirectorySnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(update: Partial<VaultDirectorySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  setVault(vaultId: string | null): void {
    if (vaultId === this.snapshot.vaultId) return
    this.epoch += 1
    this.navigation += 1
    this.pending = new Map()
    this.revealPath = null
    this.publish({ vaultId, directories: new Map(), expanded: new Set(), loading: new Set(), errors: new Map(), expandingAll: false })
  }

  private directoryExists(path: string): boolean {
    if (!path) return true
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (!this.directoryExists(parent)) return false
    return this.snapshot.directories.get(parent)?.some((entry) => entry.kind === 'folder' && entry.relativePath === path) ?? false
  }

  load(path: string): Promise<boolean> {
    if (this.snapshot.directories.has(path) && !this.snapshot.errors.has(path)) return Promise.resolve(true)
    return this.request(path)
  }

  async retry(path: string): Promise<void> {
    const epoch = this.epoch, navigation = this.navigation
    const intent = this.revealPath
    if (await this.request(path) && epoch === this.epoch && navigation === this.navigation && intent !== null && intent === this.revealPath) await this.reveal(intent)
  }

  private request(path: string): Promise<boolean> {
    const existing = this.pending.get(path)
    if (existing) return existing
    const vaultId = this.snapshot.vaultId
    if (!vaultId) return Promise.resolve(false)
    const epoch = this.epoch
    const current = (): boolean => epoch === this.epoch && vaultId === this.snapshot.vaultId
    this.publish({ loading: new Set(this.snapshot.loading).add(path) })
    // 在微任务中启动，保证finally执行前pending已登记（包括同步抛错的loader）。
    const promise = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        const entries = new Map<string, VaultTreeEntry>()
        let offset = 0
        while (current()) {
          const page = await this.loader(vaultId, path, offset)
          if (!current()) return false
          if (page.relativePath !== path) throw new Error('Vault 目录回包路径不匹配')
          for (const entry of page.entries) entries.set(entry.relativePath, entry)
          if (!page.truncated) break
          if (!Number.isSafeInteger(page.nextOffset) || (page.nextOffset ?? 0) <= offset) {
            throw new Error('Vault 目录分页游标无效，请重试')
          }
          offset = page.nextOffset ?? offset
        }
        if (!current() || (path !== '' && !this.directoryExists(path))) return false
        const directories = new Map(this.snapshot.directories)
        directories.set(path, Array.from(entries.values()))
        // 父层删除/重命名后不能留下幽灵子树。只保留本层仍有入口的子缓存。
        const retainedFolders = new Set(Array.from(entries.values()).filter((entry) => entry.kind === 'folder').map((entry) => entry.relativePath))
        const removed = (candidate: string): boolean => {
          if (candidate === path || (path && !candidate.startsWith(`${path}/`)) || !candidate) return false
          const suffix = path ? candidate.slice(path.length + 1) : candidate
          const directChild = path ? `${path}/${suffix.split('/')[0]}` : suffix.split('/')[0] ?? ''
          return !retainedFolders.has(directChild)
        }
        for (const candidate of directories.keys()) if (removed(candidate)) directories.delete(candidate)
        const expanded = new Set(Array.from(this.snapshot.expanded).filter((candidate) => !removed(candidate)))
        const errors = new Map(this.snapshot.errors); errors.delete(path)
        this.publish({ directories, expanded, errors })
        return true
      } catch (error) {
        if (current()) {
          const errors = new Map(this.snapshot.errors)
          errors.set(path, error instanceof Error ? error.message : '无法读取 Vault 目录')
          this.publish({ errors })
        }
        return false
      } finally {
        if (current()) {
          this.pending.delete(path)
          const loading = new Set(this.snapshot.loading); loading.delete(path)
          this.publish({ loading })
        }
      }
    })
    this.pending.set(path, promise)
    return promise
  }

  async toggle(path: string): Promise<void> {
    this.revealPath = null
    this.navigation += 1
    const expanded = new Set(this.snapshot.expanded)
    if (expanded.has(path)) {
      expanded.delete(path)
      this.publish({ expanded, expandingAll: false })
      return
    }
    expanded.add(path)
    this.publish({ expanded, expandingAll: false })
    await this.load(path)
  }

  collapseAll(): void {
    this.revealPath = null
    this.navigation += 1
    this.publish({ expanded: new Set(), expandingAll: false })
  }

  /** 显式定位只请求目标祖先，不扫描其他分支；用户后续操作可取消自动展开。 */
  async reveal(relativePath: string): Promise<void> {
    this.revealPath = relativePath
    this.publish({ expandingAll: false })
    const ticket = ++this.navigation
    const epoch = this.epoch
    if (!await this.load('')) return
    for (const ancestor of getVaultFolderAncestors(relativePath)) {
      if (epoch !== this.epoch || ticket !== this.navigation || !this.directoryExists(ancestor)) return
      this.publish({ expanded: new Set(this.snapshot.expanded).add(ancestor) })
      if (!await this.load(ancestor)) return
    }
  }

  async expandAll(): Promise<void> {
    this.revealPath = null
    const ticket = ++this.navigation
    const epoch = this.epoch
    this.publish({ expandingAll: true })
    const queue = ['']
    let visited = 0
    try {
      while (queue.length && ticket === this.navigation && epoch === this.epoch) {
        const path = queue.shift()
        if (path === undefined) break
        if (++visited > 10_000) throw new Error('目录过多，已暂停全部展开，请逐目录继续')
        if (!await this.load(path)) continue
        if (ticket !== this.navigation || epoch !== this.epoch) return
        if (path) this.publish({ expanded: new Set(this.snapshot.expanded).add(path) })
        for (const entry of this.snapshot.directories.get(path) ?? []) {
          if (entry.kind === 'folder') queue.push(entry.relativePath)
        }
      }
    } catch (error) {
      if (epoch === this.epoch) {
        const errors = new Map(this.snapshot.errors)
        errors.set('', error instanceof Error ? error.message : '无法全部展开')
        this.publish({ errors })
      }
    } finally {
      if (epoch === this.epoch && ticket === this.navigation) this.publish({ expandingAll: false })
    }
  }

  /** 刷新已访问层；未加载的折叠目录仍不枚举。 */
  async refresh(): Promise<void> {
    const paths = Array.from(this.snapshot.directories.keys()).sort((a, b) => a.split('/').length - b.split('/').length)
    this.epoch += 1
    this.navigation += 1
    const epoch = this.epoch
    this.pending = new Map()
    this.publish({ loading: new Set(), expandingAll: false })
    if (!await this.request('')) return
    for (const path of paths) {
      if (epoch !== this.epoch) return
      if (path && this.directoryExists(path)) await this.request(path)
    }
    if (epoch === this.epoch && this.revealPath !== null) await this.reveal(this.revealPath)
  }

  /** 保存只更新缓存元数据，不为更新文件大小而重新扫描目录。 */
  updateFile(file: VaultFileEntry): void {
    const parent = file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : ''
    const current = this.snapshot.directories.get(parent)
    if (!current) return
    // 树只消费路径/名称；保存导致的size/mtime变化不重建和重排整个已加载树。
    if (current.some((entry) => entry.kind === 'file' && entry.relativePath === file.relativePath && entry.name === file.name)) return
    const directories = new Map(this.snapshot.directories)
    directories.set(parent, [...current.filter((entry) => entry.relativePath !== file.relativePath), file])
    this.publish({ directories })
  }
}
