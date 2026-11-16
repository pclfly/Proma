/**
 * Vault 异步目录与双链解析服务。
 *
 * 官方 0.22.0 在同步目录列表之外提供：
 * - 按 cursor 分页的异步单层目录快照（TTL + 并发折叠）；
 * - 后台笔记路径索引，用于 [[双链]] 的唯一名称/后缀解析；
 * - 全程拒绝符号链接、junction、重定向和越界路径。
 *
 * 本地侧栏仍使用 `createVaultFileSystem().listDirectory` 的同步 offset 协议；
 * 本模块为双链解析与后续异步目录协议提供独立实现，二者共享同一授权根语义。
 */

import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { VaultTreeEntry } from '@proma/shared'
import { getVaultConfigPath } from './config-paths'

export interface VaultIdentity {
  rootPath: string
  vaultId: string
  configuredAt: number
}

export interface VaultDirectoryListInput {
  vaultId: string
  relativePath: string
  cursor?: string
  refresh?: boolean
}

export interface VaultDirectoryListSuccess {
  ok: true
  vaultId: string
  relativePath: string
  entries: VaultTreeEntry[]
  nextCursor: string | null
  warning?: string
}

export interface VaultDirectoryListFailure {
  ok: false
  vaultId: string
  relativePath: string
  code: string
  message: string
}

export type VaultDirectoryListResult = VaultDirectoryListSuccess | VaultDirectoryListFailure

export interface VaultWikiLinkInput {
  vaultId: string
  target: string
  sourcePath: string
  refresh?: boolean
}

export type VaultWikiLinkResult =
  | { status: 'found'; relativePath: string }
  | { status: 'missing' }
  | { status: 'indexing'; message: string }
  | { status: 'ambiguous'; message: string }
  | { status: 'error'; message: string }

type VaultFs = Pick<typeof nodeFs, 'lstat' | 'readdir' | 'realpath' | 'readFile'>
type VaultStats = Awaited<ReturnType<VaultFs['lstat']>>

export class VaultDirectoryError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'VaultDirectoryError'
    this.code = code
  }
}

interface DirectorySnapshot {
  id: string
  createdAt: number
  entries: VaultTreeEntry[]
  signature: string
  warning?: string
}

interface PendingDirectory {
  promise: Promise<DirectorySnapshot>
  refresh: boolean
}

interface VaultPathIndex {
  identityKey: string
  paths: Map<string, string>
  directorySignatures: Map<string, string>
  complete: boolean
  cancelled: boolean
  createdAt: number
  errors: string[]
  errorCount: number
}

export interface VaultDirectoryServiceOptions {
  fs?: VaultFs
  getVault?: () => Promise<VaultIdentity | null>
  now?: () => number
  pageSize?: number
  maxCachedDirectories?: number
  cacheTtlMs?: number
  indexTtlMs?: number
}

const yieldTurn = (): Promise<void> => new Promise((done) => setImmediate(done))
const entryCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function errorCode(error: unknown): string {
  if (error instanceof VaultDirectoryError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'IO_ERROR'
}

function errorMessage(error: unknown): string {
  if (error instanceof VaultDirectoryError) return error.message
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const operation = 'syscall' in error && typeof error.syscall === 'string'
      ? error.syscall
      : '读取'
    return `文件系统 ${operation} 失败（${error.code}）`
  }
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function identityKey(vault: VaultIdentity): string {
  return JSON.stringify([vault.vaultId, vault.rootPath, vault.configuredAt])
}

function withinRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === ''
    || (path !== '..'
      && !path.startsWith(`..${sep}`)
      && !isAbsolute(path))
}

/** 校验并归一化 Vault 内相对路径；拒绝绝对路径、ADS、设备名与穿越段。 */
export function normalizeVaultRelativePath(value: string): string {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.startsWith('\\\\')
  ) {
    throw new VaultDirectoryError('INVALID_PATH', 'Vault 只接受根内相对路径')
  }
  const normalized = value.replace(/\\/g, '/')
  if (!normalized) return ''
  if (
    normalized.split('/').some((part) =>
      !part
      || part === '.'
      || part === '..'
      || part.includes(':')
      || /[ .]$/.test(part)
      || /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))
  ) {
    throw new VaultDirectoryError(
      'INVALID_PATH',
      'Vault 路径不能包含空段、上级目录、ADS 或 Windows 设备名',
    )
  }
  return normalized
}

async function safePath(
  fs: VaultFs,
  root: string,
  path: string,
): Promise<{ absolutePath: string; stats: VaultStats }> {
  const absolutePath = resolve(root, path)
  if (!withinRoot(root, absolutePath)) {
    throw new VaultDirectoryError('OUTSIDE_VAULT', '路径超出授权 Vault')
  }
  let current = root
  let stats = await fs.lstat(current)
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !samePath(await fs.realpath(current), root)
  ) {
    throw new VaultDirectoryError('UNSAFE_PATH', 'Vault 根已改变或不再是普通目录')
  }
  const parts = path ? path.split('/') : []
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    stats = await fs.lstat(current)
    if (stats.isSymbolicLink() || !samePath(await fs.realpath(current), current)) {
      throw new VaultDirectoryError('UNSAFE_PATH', 'Vault 不允许软链接、junction 或重定向路径')
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw new VaultDirectoryError('NOT_DIRECTORY', 'Vault 父路径不是目录')
    }
  }
  return { absolutePath, stats }
}

function compareEntries(left: VaultTreeEntry, right: VaultTreeEntry): number {
  return (left.kind === right.kind ? 0 : left.kind === 'folder' ? -1 : 1)
    || entryCollator.compare(left.name, right.name)
    || (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
}

/** 稳定归并排序；每 256 项/合并块让出事件循环，避免大 Vault 阻塞主进程。 */
async function sortEntries(entries: VaultTreeEntry[]): Promise<VaultTreeEntry[]> {
  const batch = 256
  let runs: VaultTreeEntry[][] = []
  for (let offset = 0; offset < entries.length; offset += batch) {
    runs.push(entries.slice(offset, offset + batch).sort(compareEntries))
    await yieldTurn()
  }
  while (runs.length > 1) {
    const mergedRuns: VaultTreeEntry[][] = []
    for (let runIndex = 0; runIndex < runs.length; runIndex += 2) {
      const left = runs[runIndex]!
      const right = runs[runIndex + 1]
      if (!right) {
        mergedRuns.push(left)
        continue
      }
      const merged: VaultTreeEntry[] = []
      let leftIndex = 0
      let rightIndex = 0
      while (leftIndex < left.length || rightIndex < right.length) {
        const takeLeft = rightIndex >= right.length
          || (leftIndex < left.length && compareEntries(left[leftIndex]!, right[rightIndex]!) <= 0)
        merged.push(takeLeft ? left[leftIndex++]! : right[rightIndex++]!)
        if (merged.length % batch === 0) await yieldTurn()
      }
      mergedRuns.push(merged)
    }
    runs = mergedRuns
  }
  return runs[0] ?? []
}

async function entrySignature(entries: readonly VaultTreeEntry[]): Promise<string> {
  const hash = createHash('sha256')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    hash.update(entry.kind).update('\0').update(entry.relativePath).update('\0')
    if (index % 256 === 255) await yieldTurn()
  }
  return hash.digest('hex')
}

function createDirectoryLimiter(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((done) => waiting.push(done))
    else active += 1
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
}

async function loadConfiguredIdentity(): Promise<VaultIdentity | null> {
  let text: string
  try {
    text = await nodeFs.readFile(getVaultConfigPath(), 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (
    !value
    || typeof value !== 'object'
    || !('rootPath' in value)
    || typeof value.rootPath !== 'string'
    || !('configuredAt' in value)
    || typeof value.configuredAt !== 'number'
  ) {
    throw new VaultDirectoryError('INVALID_CONFIG', 'Vault 配置无效，请重新选择 Vault')
  }
  if (!isAbsolute(value.rootPath)) {
    throw new VaultDirectoryError('INVALID_CONFIG', 'Vault 根配置必须是绝对路径')
  }
  const rootPath = resolve(value.rootPath)
  return {
    rootPath,
    vaultId: createHash('sha256').update(rootPath, 'utf8').digest('hex'),
    configuredAt: value.configuredAt,
  }
}

export function createVaultDirectoryService(options: VaultDirectoryServiceOptions = {}) {
  const fs = options.fs ?? nodeFs
  const getVault = options.getVault ?? loadConfiguredIdentity
  const now = options.now ?? Date.now
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 256))
  const maxCached = Math.max(1, Math.floor(options.maxCachedDirectories ?? 64))
  const ttl = options.cacheTtlMs ?? 30_000
  const indexTtl = options.indexTtlMs ?? 5 * 60_000
  const snapshots = new Map<string, DirectorySnapshot>()
  const pending = new Map<string, PendingDirectory>()
  const limited = createDirectoryLimiter(4)
  let activeIdentity: string | null = null
  let index: VaultPathIndex | null = null
  let indexTail: Promise<void> = Promise.resolve()

  const invalidateIndex = (): void => {
    if (index) index.cancelled = true
    index = null
  }

  const authorize = async (id: string): Promise<VaultIdentity> => {
    const vault = await getVault()
    if (!vault || vault.vaultId !== id) {
      throw new VaultDirectoryError('VAULT_CHANGED', 'Vault 已切换或尚未授权')
    }
    const key = identityKey(vault)
    if (activeIdentity !== key) {
      activeIdentity = key
      snapshots.clear()
      pending.clear()
      invalidateIndex()
    }
    return vault
  }

  const revalidate = async (vault: VaultIdentity): Promise<void> => {
    const current = await getVault()
    if (!current || identityKey(current) !== identityKey(vault)) {
      throw new VaultDirectoryError('VAULT_CHANGED', 'Vault 已切换，请重新加载')
    }
  }

  const cacheGet = (key: string): DirectorySnapshot | undefined => {
    const value = snapshots.get(key)
    if (value && now() - value.createdAt >= ttl) return undefined
    if (value) {
      snapshots.delete(key)
      snapshots.set(key, value)
    }
    return value
  }

  const cacheSet = (key: string, value: DirectorySnapshot): void => {
    snapshots.delete(key)
    snapshots.set(key, value)
    while (snapshots.size > maxCached) {
      const oldest = snapshots.keys().next().value
      if (oldest === undefined) break
      snapshots.delete(oldest)
    }
  }

  const scanDirectory = async (
    vault: VaultIdentity,
    path: string,
    onEntry: (entry: VaultTreeEntry) => void,
    onError: (message: string) => void,
    cancelled: () => boolean = () => false,
  ): Promise<void> => {
    const target = await safePath(fs, vault.rootPath, path)
    if (!target.stats.isDirectory()) {
      throw new VaultDirectoryError('NOT_DIRECTORY', '请求路径不是目录')
    }
    const names = await fs.readdir(target.absolutePath)
    await safePath(fs, vault.rootPath, path)
    for (let index = 0; index < names.length; index += 1) {
      if (cancelled()) break
      if (index % 64 === 63) await yieldTurn()
      const name = names[index]!
      const itemPath = path ? `${path}/${name}` : name
      try {
        normalizeVaultRelativePath(itemPath)
        const absolute = join(target.absolutePath, name)
        const stats = await fs.lstat(absolute)
        if (stats.isSymbolicLink()) continue
        if (!samePath(await fs.realpath(absolute), absolute)) {
          onError(`${itemPath}: UNSAFE_PATH（跳过重定向路径）`)
          continue
        }
        if (stats.isDirectory()) {
          onEntry({ kind: 'folder', relativePath: itemPath, name })
        } else if (stats.isFile() && name.toLowerCase().endsWith('.md')) {
          onEntry({
            kind: 'file',
            relativePath: itemPath,
            name,
            size: stats.size,
            modifiedAt: stats.mtimeMs,
          })
        }
      } catch (error) {
        onError(`${itemPath}: ${errorCode(error)} (${errorMessage(error)})`)
      }
    }
    await safePath(fs, vault.rootPath, path)
    await revalidate(vault)
  }

  const listDirectory = async (input: VaultDirectoryListInput): Promise<VaultDirectoryListResult> => {
    const id = typeof input?.vaultId === 'string' ? input.vaultId : ''
    const requestedPath = typeof input?.relativePath === 'string' ? input.relativePath : ''
    try {
      if (
        !input
        || typeof input.vaultId !== 'string'
        || typeof input.relativePath !== 'string'
        || (input.cursor !== undefined && typeof input.cursor !== 'string')
        || (input.refresh !== undefined && typeof input.refresh !== 'boolean')
      ) {
        throw new VaultDirectoryError('INVALID_REQUEST', '目录请求格式错误')
      }
      const path = normalizeVaultRelativePath(input.relativePath)
      const vault = await authorize(id)
      const key = `${identityKey(vault)}:${path}`
      const previousSnapshot = snapshots.get(key)
      let snapshot = cacheGet(key)
      let offset = 0
      if (input.cursor !== undefined) {
        const parts = input.cursor.split(':')
        offset = Number(parts[1])
        if (
          input.refresh
          || pending.get(key)?.refresh
          || !snapshot
          || parts.length !== 2
          || parts[0] !== snapshot.id
          || !/^\d+$/.test(parts[1] ?? '')
          || !Number.isSafeInteger(offset)
          || offset <= 0
          || offset % pageSize !== 0
          || offset >= snapshot.entries.length
        ) {
          throw new VaultDirectoryError('STALE_CURSOR', '目录分页快照已失效，请从第一页重新加载')
        }
      } else {
        if (input.refresh) {
          snapshots.delete(key)
          snapshot = undefined
        }
        if (!snapshot) {
          const previous = pending.get(key)
          let task = previous?.promise
          if (!previous || (input.refresh && !previous.refresh)) {
            const refresh = input.refresh === true
            task = (previous ? previous.promise.catch(() => undefined) : Promise.resolve(undefined))
              .then(() => limited(async () => {
                await revalidate(vault)
                const entries: VaultTreeEntry[] = []
                const errors: string[] = []
                let errorCount = 0
                await scanDirectory(vault, path, (entry) => entries.push(entry), (message) => {
                  errorCount += 1
                  if (errors.length < 3) errors.push(message)
                })
                const sorted = await sortEntries(entries)
                const signature = await entrySignature(sorted)
                const result: DirectorySnapshot = {
                  id: randomUUID(),
                  createdAt: now(),
                  entries: sorted,
                  signature,
                }
                if (errorCount) {
                  result.warning = `有 ${errorCount} 个条目无法读取：${errors.join('；')}`
                }
                await revalidate(vault)
                const previousSignature = previousSnapshot?.warning
                  ? undefined
                  : previousSnapshot?.signature
                const indexedSignature = index?.directorySignatures.get(path)
                if (
                  !errorCount
                  && (
                    (previousSignature !== undefined && previousSignature !== signature)
                    || (indexedSignature !== undefined && indexedSignature !== signature)
                  )
                ) {
                  invalidateIndex()
                }
                if (
                  pending.get(key)?.promise === task
                  && activeIdentity === identityKey(vault)
                ) {
                  cacheSet(key, result)
                }
                return result
              }))
            pending.set(key, { promise: task, refresh })
            const currentTask = task
            void task.finally(() => {
              if (pending.get(key)?.promise === currentTask) pending.delete(key)
            }).catch(() => undefined)
          }
          snapshot = await task
        }
      }
      if (!snapshot) {
        throw new VaultDirectoryError('IO_ERROR', '目录快照不可用，请重新加载')
      }
      await safePath(fs, vault.rootPath, path)
      await revalidate(vault)
      const end = Math.min(snapshot.entries.length, offset + pageSize)
      return {
        ok: true,
        vaultId: id,
        relativePath: path,
        entries: snapshot.entries.slice(offset, end),
        nextCursor: end < snapshot.entries.length ? `${snapshot.id}:${end}` : null,
        ...(snapshot.warning ? { warning: snapshot.warning } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        vaultId: id,
        relativePath: requestedPath,
        code: errorCode(error),
        message: errorMessage(error),
      }
    }
  }

  const startIndex = (vault: VaultIdentity): VaultPathIndex => {
    const next: VaultPathIndex = {
      identityKey: identityKey(vault),
      paths: new Map(),
      directorySignatures: new Map(),
      complete: false,
      cancelled: false,
      createdAt: now(),
      errors: [],
      errorCount: 0,
    }
    index = next
    const recordError = (message: string): void => {
      next.errorCount += 1
      if (next.errors.length < 3) next.errors.push(message)
    }
    indexTail = indexTail.catch(() => undefined).then(async () => {
      const folders: string[] = ['']
      while (folders.length > 0 && !next.cancelled) {
        const path = folders.pop()!
        try {
          await revalidate(vault)
          const directoryEntries: VaultTreeEntry[] = []
          const priorErrors = next.errorCount
          await scanDirectory(vault, path, (entry) => {
            directoryEntries.push(entry)
            if (entry.kind === 'folder') folders.push(entry.relativePath)
            else next.paths.set(entry.relativePath.replace(/\.md$/i, ''), entry.relativePath)
          }, recordError, () => next.cancelled)
          if (!next.cancelled && next.errorCount === priorErrors) {
            next.directorySignatures.set(
              path,
              await entrySignature(await sortEntries(directoryEntries)),
            )
          }
        } catch (error) {
          recordError(`${path || '/'}: ${errorCode(error)} (${errorMessage(error)})`)
          if (errorCode(error) === 'VAULT_CHANGED') {
            next.cancelled = true
            break
          }
        }
        await yieldTurn()
      }
      if (!next.cancelled) {
        next.complete = true
        next.createdAt = now()
      }
    })
    void indexTail.catch((error) => {
      recordError(errorMessage(error))
      next.complete = true
    })
    return next
  }

  const probeExactNote = async (
    vault: VaultIdentity,
    stem: string,
    extension: string,
  ): Promise<string | undefined> => {
    const slash = stem.lastIndexOf('/')
    const parent = slash === -1 ? '' : stem.slice(0, slash)
    const filenameStem = stem.slice(slash + 1)
    let target: Awaited<ReturnType<typeof safePath>>
    try {
      target = await safePath(fs, vault.rootPath, parent)
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined
      throw error
    }
    if (!target.stats.isDirectory()) return undefined
    const directPath = normalizeVaultRelativePath(`${stem}${extension}`)
    try {
      const absolute = join(vault.rootPath, directPath)
      const stats = await fs.lstat(absolute)
      if (stats.isSymbolicLink()) {
        throw new VaultDirectoryError('UNSAFE_PATH', '双链不能通过软链接访问笔记')
      }
      const canonical = await fs.realpath(absolute)
      if (!samePath(dirname(canonical), target.absolutePath)) {
        throw new VaultDirectoryError('UNSAFE_PATH', '双链父目录已重定向')
      }
      if (
        stats.isFile()
        && basename(canonical).replace(/\.md$/i, '') === filenameStem
        && /\.md$/i.test(canonical)
      ) {
        const actualPath = relative(vault.rootPath, canonical).split(sep).join('/')
        if ((await safePath(fs, vault.rootPath, actualPath)).stats.isFile()) return actualPath
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error
    }
    const names = await fs.readdir(target.absolutePath)
    await safePath(fs, vault.rootPath, parent)
    for (let index = 0; index < names.length; index += 1) {
      if (index % 256 === 255) await yieldTurn()
      const name = names[index]!
      if (!/\.md$/i.test(name) || name.replace(/\.md$/i, '') !== filenameStem) continue
      const path = normalizeVaultRelativePath(parent ? `${parent}/${name}` : name)
      try {
        if ((await safePath(fs, vault.rootPath, path)).stats.isFile()) return path
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  const resolveWikiLink = async (input: VaultWikiLinkInput): Promise<VaultWikiLinkResult> => {
    try {
      if (
        !input
        || typeof input.vaultId !== 'string'
        || typeof input.target !== 'string'
        || typeof input.sourcePath !== 'string'
        || (input.refresh !== undefined && typeof input.refresh !== 'boolean')
      ) {
        throw new VaultDirectoryError('INVALID_REQUEST', '双链请求格式错误')
      }
      const source = normalizeVaultRelativePath(input.sourcePath)
      if (!source.toLowerCase().endsWith('.md')) {
        throw new VaultDirectoryError('INVALID_PATH', '双链来源必须是 Markdown 路径')
      }
      const requestedTarget = input.target.trim().replace(/\\/g, '/')
      const extension = requestedTarget.match(/\.md$/i)?.[0] ?? '.md'
      const note = requestedTarget.replace(/\.md$/i, '')
      if (
        !note
        || /[#^:\0]/.test(note)
        || note.startsWith('/')
        || note.startsWith('\\')
      ) {
        throw new VaultDirectoryError('INVALID_LINK', '仅支持 Vault 内笔记路径双链')
      }
      const localOnly = note.startsWith('./') || note.startsWith('../')
      const normalizeLink = (path: string): string => {
        const parts: string[] = []
        for (const part of path.replace(/\\/g, '/').split('/')) {
          if (part === '..') {
            if (parts.length === 0) {
              throw new VaultDirectoryError('INVALID_LINK', '双链超出 Vault 根目录')
            }
            parts.pop()
          } else if (part && part !== '.') {
            parts.push(part)
          }
        }
        return normalizeVaultRelativePath(parts.join('/'))
      }
      const folder = source.slice(0, source.lastIndexOf('/') + 1)
      const local = normalizeLink(folder + note)
      const root = localOnly ? '' : normalizeLink(note)
      const vault = await authorize(input.vaultId)
      await safePath(fs, vault.rootPath, '')
      if (index?.complete && (input.refresh || now() - index.createdAt >= indexTtl)) {
        invalidateIndex()
      }
      const exact = await probeExactNote(vault, localOnly ? local : root, extension)
      if (exact) {
        await revalidate(vault)
        return { status: 'found', relativePath: exact }
      }
      if (localOnly) {
        await revalidate(vault)
        return { status: 'missing' }
      }
      const localExact = root === local
        ? undefined
        : await probeExactNote(vault, local, extension)
      if (localExact) {
        await revalidate(vault)
        return { status: 'found', relativePath: localExact }
      }
      const current = index ?? startIndex(vault)
      if (!current.complete) {
        return { status: 'indexing', message: '正在后台建立笔记路径索引，请稍后重试' }
      }
      if (current.cancelled || current.identityKey !== identityKey(vault)) {
        return { status: 'error', message: 'Vault 索引已失效，请重试' }
      }
      if (current.errorCount) {
        return {
          status: 'error',
          message: `笔记索引不完整（${current.errorCount} 处失败）：${current.errors.join('；')}`,
        }
      }
      let found = localOnly
        ? current.paths.get(local)
        : current.paths.get(root) ?? current.paths.get(local)
      let ambiguous = false
      if (!found && !localOnly) {
        let count = 0
        for (const [stem, path] of current.paths) {
          if (stem.endsWith(`/${note}`)) {
            if (found) {
              ambiguous = true
              break
            }
            found = path
          }
          count += 1
          if (count % 256 === 0) await yieldTurn()
        }
      }
      await revalidate(vault)
      if (index !== current || current.cancelled) {
        return { status: 'indexing', message: '索引已刷新，请稍后重试' }
      }
      if (ambiguous) {
        return {
          status: 'ambiguous',
          message: '存在多个同名笔记，请使用完整的 Vault 内路径',
        }
      }
      if (!found) return { status: 'missing' }
      const target = await safePath(fs, vault.rootPath, found)
      if (!target.stats.isFile()) {
        return { status: 'error', message: '索引目标已改变，请刷新后重试' }
      }
      await revalidate(vault)
      return { status: 'found', relativePath: found }
    } catch (error) {
      return { status: 'error', message: `${errorCode(error)}: ${errorMessage(error)}` }
    }
  }

  return { listDirectory, resolveWikiLink, invalidateIndex }
}

/** 校验 Vault 展示目标仍位于当前根内且类型未变。 */
export async function assertVaultFocusTarget(
  rootPath: string,
  relativePath: string,
  kind: 'file' | 'folder',
): Promise<string> {
  const path = normalizeVaultRelativePath(relativePath)
  if (kind === 'file' && !path.toLowerCase().endsWith('.md')) {
    throw new VaultDirectoryError('INVALID_PATH', 'Vault 焦点仅支持 Markdown 文件')
  }
  const target = await safePath(nodeFs, rootPath, path)
  if (kind === 'file' ? !target.stats.isFile() : !target.stats.isDirectory()) {
    throw new VaultDirectoryError('INVALID_PATH', 'Vault 焦点目标类型已改变')
  }
  return path
}

const configuredService = createVaultDirectoryService()

export function listVaultDirectory(input: VaultDirectoryListInput): Promise<VaultDirectoryListResult> {
  return configuredService.listDirectory(input)
}

export function resolveVaultWikiLink(input: VaultWikiLinkInput): Promise<VaultWikiLinkResult> {
  return configuredService.resolveWikiLink(input)
}

export function invalidateConfiguredVaultIndex(): void {
  configuredService.invalidateIndex()
}
