import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkspaceFileSearchService } from './workspace-file-search'
import type { WorkspaceFileSearchService } from './workspace-file-search'
import type { IndexedSearchEntry, RootScanner } from './workspace-file-search-scan'

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const fileEntry = (name: string, relativePath = name): IndexedSearchEntry => ({
  name,
  relativePath,
  type: 'file',
})

const dirEntry = (name: string, relativePath = name): IndexedSearchEntry => ({
  name,
  relativePath,
  type: 'dir',
})

interface ScannerFixture {
  service: WorkspaceFileSearchService
  calls: string[]
  setEntries: (root: string, entries: IndexedSearchEntry[], truncated?: boolean) => void
  advance: (ms: number) => void
}

function createFixture(options: { ttlMs?: number; delayMs?: number } = {}): ScannerFixture {
  const calls: string[] = []
  const entriesByRoot = new Map<string, IndexedSearchEntry[]>()
  const truncatedByRoot = new Map<string, boolean>()
  const clock = { value: 1_000 }

  const scanner: RootScanner = async (root) => {
    calls.push(root)
    if (options.delayMs) await wait(options.delayMs)
    return {
      root,
      kind: 'directory',
      entries: entriesByRoot.get(root) ?? [],
      scannedAt: clock.value,
      truncated: truncatedByRoot.get(root) ?? false,
    }
  }

  const service = createWorkspaceFileSearchService({
    scanner,
    now: () => clock.value,
    ttlMs: options.ttlMs ?? 1000,
  })

  return {
    service,
    calls,
    setEntries: (root, entries, truncated = false) => {
      entriesByRoot.set(resolve(root), entries)
      truncatedByRoot.set(resolve(root), truncated)
    },
    advance: (ms) => {
      clock.value += ms
    },
  }
}

const tempRoots: string[] = []

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-file-search-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('工作区文件索引搜索', () => {
  it('文件名前缀命中排在文件名包含与路径命中之前', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, [
      fileEntry('my-index.ts'),
      fileEntry('guide.md', 'index-guide/guide.md'),
      fileEntry('index-helper.md'),
      fileEntry('index.ts'),
      fileEntry('insidex.ts'),
    ])

    const result = await fixture.service.search({ rootPath: root, query: 'index', limit: 10 })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      'index.ts',
      'index-helper.md',
      'my-index.ts',
      'guide.md',
      'insidex.ts',
    ])
    expect(result.total).toBe(5)
  })

  it('匹配大小写不敏感且保留原始名称', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, [fileEntry('README.md'), fileEntry('ReadmeLoader.ts', 'src/ReadmeLoader.ts')])

    const result = await fixture.service.search({ rootPath: root, query: 'readme', limit: 10 })

    expect(result.entries.map((entry) => entry.name)).toEqual(['README.md', 'ReadmeLoader.ts'])
  })

  it('同分数时文件排在目录之前，空查询则目录优先', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, [dirEntry('src'), fileEntry('src.ts'), fileEntry('index.ts', 'components/index.ts')])

    const matched = await fixture.service.search({ rootPath: root, query: 'src', limit: 10 })
    expect(matched.entries.map((entry) => entry.name)).toEqual(['src.ts', 'src'])

    const browse = await fixture.service.search({ rootPath: root, query: '', limit: 10 })
    expect(browse.entries.map((entry) => entry.name)).toEqual(['src', 'src.ts', 'index.ts'])
    expect(browse.total).toBe(3)
  })

  it('limit 只截断返回条目，total 仍统计全部命中', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, Array.from({ length: 8 }, (_value, index) => fileEntry(`report-${index}.md`)))

    const result = await fixture.service.search({ rootPath: root, query: 'report', limit: 3 })

    expect(result.entries).toHaveLength(3)
    expect(result.total).toBe(8)
    expect(result.sessionEntries).toHaveLength(3)
  })

  it('索引触顶时返回 truncated 标记', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, [fileEntry('a.ts')], true)

    const result = await fixture.service.search({ rootPath: root, query: 'a', limit: 5 })
    expect(result.truncated).toBe(true)

    const realRoot = createTempRoot()
    for (let index = 0; index < 5; index++) writeFileSync(join(realRoot, `file-${index}.txt`), '')
    const realService = createWorkspaceFileSearchService({ maxEntriesPerRoot: 2 })
    const realResult = await realService.search({ rootPath: realRoot, query: 'file', limit: 10 })
    expect(realResult.truncated).toBe(true)
    expect(realResult.total).toBe(2)
  })

  it('TTL 过期与脏标记只重建对应根', async () => {
    const fixture = createFixture({ ttlMs: 1000 })
    const root = resolve('C:/workspace/demo')
    const attached = resolve('C:/workspace/attached')
    fixture.setEntries(root, [fileEntry('index.ts')])
    fixture.setEntries(attached, [fileEntry('extra.ts')])

    const input = { rootPath: root, query: 'index', limit: 10, additionalPaths: [attached] }
    await fixture.service.search(input)
    expect(fixture.calls).toEqual([root, attached])

    // 命中缓存，不重复扫描
    await fixture.service.search(input)
    expect(fixture.calls).toEqual([root, attached])

    // 只标记附加目录：下一次查询仅重建附加目录
    fixture.service.invalidate(attached)
    await fixture.service.search(input)
    expect(fixture.calls).toEqual([root, attached, attached])

    // TTL 过期后根索引与附加目录都会重建
    fixture.advance(1500)
    await fixture.service.search(input)
    expect(fixture.calls).toEqual([root, attached, attached, root, attached])

    fixture.service.dispose()
  })

  it('同一根并发查询共享同一个 in-flight 构建', async () => {
    const fixture = createFixture({ delayMs: 20 })
    const root = resolve('C:/workspace/demo')
    fixture.setEntries(root, [fileEntry('index.ts'), fileEntry('main.ts')])

    const [first, second] = await Promise.all([
      fixture.service.search({ rootPath: root, query: 'index', limit: 10 }),
      fixture.service.search({ rootPath: root, query: 'main', limit: 10 }),
    ])

    expect(fixture.calls).toEqual([root])
    expect(first.entries.map((entry) => entry.name)).toEqual(['index.ts'])
    expect(second.entries.map((entry) => entry.name)).toEqual(['main.ts'])
  })

  it('按变更路径失效包含该路径的根索引', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo')
    const other = resolve('C:/workspace/other')
    fixture.setEntries(root, [fileEntry('index.ts')])
    fixture.setEntries(other, [fileEntry('other.ts')])

    await fixture.service.search({ rootPath: root, query: '', limit: 10 })
    await fixture.service.search({ rootPath: other, query: '', limit: 10 })
    expect(fixture.calls).toEqual([root, other])

    fixture.service.invalidatePaths([join(root, 'src', 'index.ts')])
    await fixture.service.search({ rootPath: root, query: '', limit: 10 })
    await fixture.service.search({ rootPath: other, query: '', limit: 10 })
    expect(fixture.calls).toEqual([root, other, root])
  })

  it('扫描真实目录时忽略 node_modules/.git/dist 等目录', async () => {
    const root = createTempRoot()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'src', 'app.ts'), '')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')
    writeFileSync(join(root, '.git', 'config'), '')
    writeFileSync(join(root, 'dist', 'main.js'), '')
    writeFileSync(join(root, 'README.md'), '')

    const service = createWorkspaceFileSearchService()
    const result = await service.search({ rootPath: root, query: '', limit: 50 })

    const paths = result.entries.map((entry) => entry.path)
    expect(paths).toContain('src')
    expect(paths).toContain('src/app.ts')
    expect(paths).toContain('README.md')
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false)
    expect(paths.some((path) => path.includes('.git'))).toBe(false)
    expect(paths.some((path) => path.includes('dist'))).toBe(false)
  })

  it('附加目录使用绝对路径并标注 workspace 来源', async () => {
    const fixture = createFixture()
    const root = resolve('C:/workspace/demo/workspace-files')
    const sessionAttached = resolve('C:/workspace/session-assets')
    const workspaceAttached = resolve('C:/workspace/project')
    fixture.setEntries(root, [fileEntry('index.ts')])
    fixture.setEntries(sessionAttached, [fileEntry('notes.md')])
    fixture.setEntries(workspaceAttached, [fileEntry('main.rs')])

    const result = await fixture.service.search({
      rootPath: root,
      query: '',
      limit: 10,
      sessionPaths: [sessionAttached],
      additionalPaths: [workspaceAttached],
    })

    const workspaceSource = result.workspaceEntries.filter((entry) => entry.source === 'workspace')
    expect(workspaceSource.map((entry) => entry.path)).toContain(join(workspaceAttached, 'main.rs'))
    const sessionProjectedPaths = result.sessionEntries.map((entry) => entry.path)
    expect(sessionProjectedPaths).toContain('index.ts')
    expect(sessionProjectedPaths).toContain(join(sessionAttached, 'notes.md'))

    const attachedRoot = result.workspaceEntries.find((entry) => entry.path === workspaceAttached)
    expect(attachedRoot?.type).toBe('dir')
    expect(attachedRoot?.source).toBe('workspace')
  })

  it('根目录不存在时返回空结果且不抛异常', async () => {
    const service = createWorkspaceFileSearchService()
    const missingRoot = join(tmpdir(), `proma-missing-root-${Date.now()}`)

    const result = await service.search({ rootPath: missingRoot, query: 'index', limit: 10 })

    expect(result.entries).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
  })
})