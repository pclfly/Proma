import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { rmSyncWithRetry } from './fs-retry'

const actualSafeFile = { ...await import('./safe-file') }
let beforeAtomicWrite: (() => void) | undefined
mock.module('./safe-file', () => ({
  ...actualSafeFile,
  writeTextFileAtomic: (file: string, content: string, options?: { beforeCommit?: () => void }) => {
    const hook = beforeAtomicWrite
    beforeAtomicWrite = undefined
    hook?.()
    return actualSafeFile.writeTextFileAtomic(file, content, options)
  },
}))
let tempHome = ''
let manager: typeof import('./agent-workspace-manager')
let counter = 0
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
mock.module('node:os', () => ({ ...os, homedir: () => tempHome }))
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tempHome, 'AppData') },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, nativeImage: {}, nativeTheme: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))
afterEach(() => { beforeAtomicWrite = undefined })
beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-knowledge-write-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  manager = await import('./agent-workspace-manager')
})
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSyncWithRetry(tempHome, { recursive: true, force: true })
})
function fixture() {
  const slug = `knowledge-${++counter}`
  const root = join(tempHome, '.proma', 'agent-workspaces', slug)
  const memory = join(root, 'memory')
  mkdirSync(memory, { recursive: true })
  // 知识入口必须验证已登记slug；fixture同步构造隔离注册表，而不是放宽生产边界。
  actualSafeFile.writeJsonFileAtomic(join(tempHome, '.proma', 'agent-workspaces.json'), { version: 2, workspaces: Array.from({ length: counter }, (_, i) => ({ id: `knowledge-${i + 1}`, slug: `knowledge-${i + 1}`, name: `测试项目 ${i + 1}`, createdAt: 1, updatedAt: 1 })) })
  return { slug, root, memory }
}
function fileLink(target: string, link: string) { symlinkSync(target, link, 'file') }
function directoryLink(target: string, link: string) { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir') }

describe('知识文件原子保存与符号链接', () => {
  test('Given 普通记忆及新建子目录 When 保存 Then 内容正确且保留乐观并发校验', () => {
    const { slug, memory } = fixture()
    manager.writeWorkspaceAutoMemoryFile(slug, 'nested/note.md', 'first', '')
    expect(readFileSync(join(memory, 'nested/note.md'), 'utf8')).toBe('first')
    manager.writeWorkspaceAutoMemoryFile(slug, 'nested/note.md', 'second', 'first')
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'nested/note.md', 'stale', 'first')).toThrow('外部更新')
    expect(readFileSync(join(memory, 'nested/note.md'), 'utf8')).toBe('second')
  })
  test('Given 授权根内的文件链接 When 保存记忆 Then 保留链接并原子更新真实目标', () => {
    const { slug, memory } = fixture()
    const target = join(memory, 'target.md')
    const alias = join(memory, 'alias.md')
    writeFileSync(target, 'old')
    fileLink(target, alias)
    manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'new', 'old')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readFileSync(alias, 'utf8')).toBe('new')
  })
  test('Given 授权根内目录链接 When 保存子文件 Then 不替换目录链接', () => {
    const { slug, memory } = fixture()
    const target = join(memory, 'real')
    const alias = join(memory, 'alias')
    mkdirSync(target)
    directoryLink(target, alias)
    manager.writeWorkspaceAutoMemoryFile(slug, 'alias/note.md', 'new', '')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(target, 'note.md'), 'utf8')).toBe('new')
  })
  test('Given 外置目标或目录链接 When 保存 Then 拒绝越界且不改变链接与外部内容', () => {
    const { slug, root, memory } = fixture()
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    fileLink(outside, join(memory, 'alias.md'))
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'bad')).toThrow()
    directoryLink(root, join(memory, 'directory'))
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'directory/new.md', 'bad')).toThrow()
    expect(lstatSync(join(memory, 'alias.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
    expect(existsSync(join(root, 'new.md'))).toBe(false)
  })
  test('Given 断链或循环链接 When 保存 Then 显式拒绝而不是覆盖链接', () => {
    const { slug, memory } = fixture()
    const broken = join(memory, 'broken.md')
    fileLink(join(memory, 'missing.md'), broken)
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'broken.md', 'bad', '')).toThrow()
    expect(lstatSync(broken).isSymbolicLink()).toBe(true)
    const cycle = join(memory, 'cycle.md')
    fileLink(cycle, cycle)
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'cycle.md', 'bad', '')).toThrow()
    expect(lstatSync(cycle).isSymbolicLink()).toBe(true)
  })
  test('Given 解析后链接被重定向 When 原子提交 Then 拒绝保存且清理临时文件', () => {
    const { slug, memory } = fixture()
    const first = join(memory, 'first.md')
    const second = join(memory, 'second.md')
    const alias = join(memory, 'alias.md')
    writeFileSync(first, 'same')
    writeFileSync(second, 'same')
    fileLink(first, alias)
    beforeAtomicWrite = () => { unlinkSync(alias); fileLink(second, alias) }
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'bad', 'same')).toThrow('路径已变化')
    expect(readlinkSync(alias)).toBe(second)
    expect(readFileSync(first, 'utf8')).toBe('same')
    expect(readFileSync(second, 'utf8')).toBe('same')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readdirSync(memory).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  test('Given 准备期间真实文件被其他编辑更新 When 原子提交 Then 不覆盖较新内容', () => {
    const { slug, memory } = fixture()
    const target = join(memory, 'target.md')
    writeFileSync(target, 'old')
    beforeAtomicWrite = () => writeFileSync(target, 'external')
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'target.md', 'bad', 'old')).toThrow('外部更新')
    expect(readFileSync(target, 'utf8')).toBe('external')
    expect(readdirSync(memory).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  test('Given 准备期间目录链接被换到外部 When 提交 Then 不写任何外部目标', () => {
    const { slug, root, memory } = fixture()
    const real = join(memory, 'real')
    const outside = join(root, 'outside')
    const alias = join(memory, 'alias')
    mkdirSync(real)
    mkdirSync(outside)
    writeFileSync(join(real, 'note.md'), 'old')
    writeFileSync(join(outside, 'note.md'), 'outside')
    directoryLink(real, alias)
    beforeAtomicWrite = () => { unlinkSync(alias); directoryLink(outside, alias) }
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'alias/note.md', 'bad', 'old')).toThrow('路径已变化')
    expect(readFileSync(join(real, 'note.md'), 'utf8')).toBe('old')
    expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('outside')
    expect(readdirSync(real).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  for (const viaLink of [false, true]) {
    test(`Given ${viaLink ? '目录链接' : '普通目录'}中的新文件 When 真实父目录被同路径替换 Then 拒绝保存`, () => {
      const { slug, memory } = fixture()
      const real = join(memory, 'real')
      const moved = join(memory, 'moved')
      mkdirSync(real)
      if (viaLink) directoryLink(real, join(memory, 'alias'))
      beforeAtomicWrite = () => { renameSync(real, moved); mkdirSync(real) }
      expect(() => manager.writeWorkspaceAutoMemoryFile(slug, `${viaLink ? 'alias' : 'real'}/new.md`, 'bad', '')).toThrow('路径已变化')
      expect(existsSync(join(real, 'new.md'))).toBe(false)
      expect(existsSync(join(moved, 'new.md'))).toBe(false)
      expect(readdirSync(real)).toEqual([])
      expect(readdirSync(moved)).toEqual([])
      if (viaLink) expect(lstatSync(join(memory, 'alias')).isSymbolicLink()).toBe(true)
    })
  }
  test('Given 通用原子writer收到链接 When 无知识文件解析时保存 Then 仍替换路径本身而不跟随链接', () => {
    const { memory } = fixture()
    const target = join(memory, 'target.md')
    const alias = join(memory, 'alias.md')
    writeFileSync(target, 'original')
    fileLink(target, alias)
    actualSafeFile.writeTextFileAtomic(alias, 'replacement')
    expect(lstatSync(alias).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(readFileSync(alias, 'utf8')).toBe('replacement')
  })
  test('Given 工作区规则指向外部文件 When 保存 Then 不把外置链接自动视为已授权', () => {
    const { slug, root } = fixture()
    const external = join(tempHome, `external-${slug}.md`)
    writeFileSync(external, 'outside')
    fileLink(external, join(root, 'AGENTS.md'))
    expect(() => manager.writeWorkspaceAgentsMd(slug, 'bad', 'outside')).toThrow('授权目录外')
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(external, 'utf8')).toBe('outside')
  })
  test('Given 工作区规则是根内文件链接 When 用户显式保存 Then 保留链接且不扩展外置授权', () => {
    const { slug, root } = fixture()
    const target = join(root, 'rules.md')
    const alias = join(root, 'AGENTS.md')
    writeFileSync(target, 'old rules')
    fileLink(target, alias)
    manager.writeWorkspaceAgentsMd(slug, 'new rules', 'old rules')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('new rules')
  })
})

describe('知识读写统一链接授权', () => {
  test('Given 外置AGENTS链接未授权 When 读取/摘要 Then 不跟随正文或读取外部元数据', () => {
    const { slug, root } = fixture()
    const outside = join(tempHome, `private-${slug}`)
    mkdirSync(outside)
    writeFileSync(join(outside, 'rules.md'), 'private')
    fileLink(join(outside, 'rules.md'), join(root, 'AGENTS.md'))
    expect(() => manager.readWorkspaceAgentsMd(slug)).toThrow('授权')
    expect(manager.getWorkspaceMemorySummary(slug).agentsMd).toMatchObject({ exists: false, size: 0, linkState: 'unauthorized' })
  })
  test('Given 外置目录链接 When 显式附加后 Then 树/读取/保存共享授权并保留逻辑链接', () => {
    const { slug, memory } = fixture()
    const external = join(tempHome, `grant-${slug}`)
    mkdirSync(external)
    writeFileSync(join(external, 'note.md'), 'before')
    directoryLink(external, join(memory, 'linked'))
    expect(manager.listWorkspaceAutoMemoryFiles(slug).find(node => node.name === 'linked')?.linkState).toBe('unauthorized')
    manager.attachWorkspaceDirectory(slug, realpathSync(external))
    expect(manager.listWorkspaceAutoMemoryFiles(slug).find(node => node.name === 'linked')?.linkState).toBe('authorized')
    expect(manager.readWorkspaceAutoMemoryFile(slug, 'linked/note.md').content).toBe('before')
    manager.writeWorkspaceAutoMemoryFile(slug, 'linked/note.md', 'after', 'before')
    expect(readFileSync(join(external, 'note.md'), 'utf8')).toBe('after')
    expect(lstatSync(join(memory, 'linked')).isSymbolicLink()).toBe(true)
    beforeAtomicWrite = () => { manager.detachWorkspaceDirectory(slug, realpathSync(external)) }
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'linked/note.md', 'unsafe', 'after')).toThrow('路径已变化')
    expect(readFileSync(join(external, 'note.md'), 'utf8')).toBe('after')
    expect(() => manager.readWorkspaceAutoMemoryFile(slug, 'linked/note.md')).toThrow('授权')
  })
  test('Given 整个memory根为外链 When 授权后保存 Then 不替换根链接且各入口一致', () => {
    const { slug, memory } = fixture()
    const external = join(tempHome, `root-grant-${slug}`)
    mkdirSync(external)
    writeFileSync(join(external, 'MEMORY.md'), 'root-before')
    rmSync(memory, { recursive: true })
    directoryLink(external, memory)
    expect(() => manager.readWorkspaceAutoMemoryFile(slug, 'MEMORY.md')).toThrow()
    manager.attachWorkspaceDirectory(slug, realpathSync(external))
    expect(manager.getWorkspaceMemorySummary(slug).autoMemory.memoryMdExists).toBe(true)
    expect(manager.readWorkspaceAutoMemoryFile(slug, 'MEMORY.md').content).toBe('root-before')
    manager.writeWorkspaceAutoMemoryFile(slug, 'MEMORY.md', 'root-after', 'root-before')
    expect(readFileSync(join(external, 'MEMORY.md'), 'utf8')).toBe('root-after')
    expect(lstatSync(memory).isSymbolicLink()).toBe(true)
  })
  test('Given 未知或穿越slug When 读取 Then 拒绝且不创建目录', () => {
    const unknown = 'unregistered-knowledge'
    expect(() => manager.readWorkspaceAgentsMd(unknown)).toThrow('工作区')
    expect(() => manager.listWorkspaceAutoMemoryFiles('../escape')).toThrow()
    expect(existsSync(join(tempHome, '.proma', 'agent-workspaces', unknown))).toBe(false)
  })
})

test('Given 树被512文件预算截断 When 索引在预算之后 Then 摘要仍安全报告存在而非假缺失', () => {
  const { slug, memory } = fixture()
  for (let index = 0; index < 520; index += 1) writeFileSync(join(memory, `${String(index).padStart(4, '0')}.md`), '')
  writeFileSync(join(memory, 'MEMORY.md'), 'index present')
  const summary = manager.getWorkspaceMemorySummary(slug)
  expect(summary.autoMemory.truncated).toBe(true)
  expect(summary.autoMemory.memoryMdExists).toBe(true)
  expect(manager.readWorkspaceAutoMemoryFile(slug, 'MEMORY.md').content).toBe('index present')
})

describe('读票据：read→save 换向与授权撤销', () => {
  test('Given 整个memory根尚不存在 When 读取后首次写入索引 Then 建根并签发后继票据', () => {
    const slug = `first-index-${++counter}`
    const root = join(tempHome, '.proma', 'agent-workspaces', slug)
    mkdirSync(root, { recursive: true })
    actualSafeFile.writeJsonFileAtomic(join(tempHome, '.proma', 'agent-workspaces.json'), { version: 2, workspaces: Array.from({ length: counter }, (_, i) => ({ id: `knowledge-${i + 1}`, slug: `knowledge-${i + 1}`, name: `测试项目 ${i + 1}`, createdAt: 1, updatedAt: 1 })) })
    const indexSlug = `knowledge-${counter}`
    const indexPath = join(tempHome, '.proma', 'agent-workspaces', indexSlug)
    mkdirSync(indexPath, { recursive: true })
    const missing = manager.readWorkspaceAutoMemoryFile(indexSlug, 'MEMORY.md')
    // 缺失文件不返回正文（content 为可选），UI 用 ?? '' 作为空基线。
    expect(missing.content ?? '').toBe('')
    expect(missing.revision).toBeTruthy()
    const written = manager.writeWorkspaceAutoMemoryFile(indexSlug, 'MEMORY.md', '#-first-index', '', missing.revision)
    expect(written.requiresReopen).toBeUndefined()
    expect(written.revision).toBeTruthy()
    // 第二次保存用返回的后继票据，证明边界未因自建目录而失效。
    manager.writeWorkspaceAutoMemoryFile(indexSlug, 'MEMORY.md', '#-second-index', '#-first-index', written.revision)
    expect(readFileSync(join(indexPath, 'memory', 'MEMORY.md'), 'utf8')).toBe('#-second-index')
    expect(manager.getWorkspaceMemorySummary(indexSlug).autoMemory.memoryMdExists).toBe(true)
  })

  test('Given 读到保存之间别名换成同内容另一授权文件 When 保存 Then 拒绝且两个目标都不变', () => {
    const { slug, memory } = fixture()
    const external = join(tempHome, `revision-grant-${slug}`)
    mkdirSync(external)
    const a = join(memory, 'a.md'), b = join(external, 'b.md'), alias = join(memory, 'alias.md')
    writeFileSync(a, 'same-content'); writeFileSync(b, 'same-content')
    fileLink(a, alias)
    manager.attachWorkspaceDirectory(slug, realpathSync(external))
    const read = manager.readWorkspaceAutoMemoryFile(slug, 'alias.md')
    expect(read.content).toBe('same-content'); expect(read.revision).toBeTruthy()
    unlinkSync(alias); fileLink(b, alias)
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'user-edit', 'same-content', read.revision)).toThrow('路径已变化')
    expect(readFileSync(a, 'utf8')).toBe('same-content')
    expect(readFileSync(b, 'utf8')).toBe('same-content')
  })
  test('Given 读到保存之间撤销外置授权 When 保存 Then 拒绝且票据不可重放', () => {
    const { slug, memory } = fixture()
    const external = join(tempHome, `revision-revoke-${slug}`)
    mkdirSync(external); writeFileSync(join(external, 'note.md'), 'before')
    manager.attachWorkspaceDirectory(slug, realpathSync(external))
    directoryLink(external, join(memory, 'linked'))
    const read = manager.readWorkspaceAutoMemoryFile(slug, 'linked/note.md')
    manager.detachWorkspaceDirectory(slug, realpathSync(external))
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'linked/note.md', 'after', 'before', read.revision)).toThrow()
    expect(readFileSync(join(external, 'note.md'), 'utf8')).toBe('before')
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'linked/note.md', 'after', 'before', read.revision)).toThrow('票据')
  })
  test('Given 票据对应的物理目标未变 When 用户保存 Then 正常写入且同票据不能重用', () => {    const { slug, memory } = fixture()
    writeFileSync(join(memory, 'note.md'), 'v1')
    const read = manager.readWorkspaceAutoMemoryFile(slug, 'note.md')
    manager.writeWorkspaceAutoMemoryFile(slug, 'note.md', 'v2', 'v1', read.revision)
    expect(readFileSync(join(memory, 'note.md'), 'utf8')).toBe('v2')
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'note.md', 'v3', 'v2', read.revision)).toThrow('票据')
    expect(readFileSync(join(memory, 'note.md'), 'utf8')).toBe('v2')
  })
  test('Given 票据尚未消费 When 磁盘内容被外部修改 Then 仍以内容基线拒绝覆盖', () => {
    const { slug, memory } = fixture()
    writeFileSync(join(memory, 'note.md'), 'v1')
    const read = manager.readWorkspaceAutoMemoryFile(slug, 'note.md')
    writeFileSync(join(memory, 'note.md'), 'external')
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'note.md', 'mine', 'v1', read.revision)).toThrow('更新')
    expect(readFileSync(join(memory, 'note.md'), 'utf8')).toBe('external')
  })
  test('Given AGENTS与memory票据 When 交叉用于另一目标 Then 不匹配而拒绝', () => {
    const { slug, memory } = fixture()
    writeFileSync(join(memory, 'note.md'), 'note')
    const memoryRead = manager.readWorkspaceAutoMemoryFile(slug, 'note.md')
    expect(() => manager.writeWorkspaceAgentsMd(slug, 'rules', undefined, memoryRead.revision)).toThrow('不匹配')
    const agentsRead = manager.readWorkspaceAgentsMd(slug)
    expect(agentsRead.revision).toBeTruthy()
  })
})

test('Given 读票据 When 消费 Then 只保留摘要元数据而不复制正文', async () => {
  const { slug, memory } = fixture()
  writeFileSync(join(memory, 'secret.md'), 'super-secret-body')
  const read = manager.readWorkspaceAutoMemoryFile(slug, 'secret.md')
  const { consumeKnowledgeReadTicket } = await import('./workspace-knowledge-read-ticket')
  const ticket = consumeKnowledgeReadTicket(read.revision!, { workspaceSlug: slug, kind: 'memory', relativePath: 'secret.md' })
  expect(Object.keys(ticket)).not.toContain('content')
  expect(JSON.stringify(ticket)).not.toContain('super-secret-body')
})

test('Given 撤销后再授权同一目录 When 旧票据迟到保存 Then 票据已失效', () => {
  const { slug, memory } = fixture()
  const external = join(tempHome, `regrant-${slug}`)
  mkdirSync(external); writeFileSync(join(external, 'note.md'), 'before')
  manager.attachWorkspaceDirectory(slug, realpathSync(external))
  directoryLink(external, join(memory, 'linked'))
  const read = manager.readWorkspaceAutoMemoryFile(slug, 'linked/note.md')
  manager.detachWorkspaceDirectory(slug, realpathSync(external))
  manager.attachWorkspaceDirectory(slug, realpathSync(external))
  expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'linked/note.md', 'old-editor', 'before', read.revision)).toThrow('票据')
  expect(readFileSync(join(external, 'note.md'), 'utf8')).toBe('before')
})

describe('保存后续票与实际提交目标绑定', () => {
  test('Given 保存成功返回后继票据 When 别名随后换向 Then 下一次保存拒绝且不写新目标', () => {
    const { slug, memory } = fixture()
    const external = join(tempHome, `renew-${slug}`)
    mkdirSync(external)
    const a = join(memory, 'a.md'), b = join(external, 'b.md'), alias = join(memory, 'alias.md')
    writeFileSync(a, 'first'); writeFileSync(b, 'first')
    fileLink(a, alias)
    manager.attachWorkspaceDirectory(slug, realpathSync(external))
    const read = manager.readWorkspaceAutoMemoryFile(slug, 'alias.md')
    expect(read.revision).toBeTruthy()
    const written = manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'second', 'first', read.revision)
    // 后继票据必须存在，且与实际提交目标绑定。
    expect(written.revision).toBeTruthy()
    unlinkSync(alias); fileLink(b, alias)
    expect(() => manager.writeWorkspaceAutoMemoryFile(slug, 'alias.md', 'third', 'second', written.revision)).toThrow('路径已变化')
    expect(readFileSync(a, 'utf8')).toBe('second')
    expect(readFileSync(b, 'utf8')).toBe('first')
  })

  test('Given 未知或非法工作区 When 归因分类 Then 不创建任何目录', async () => {
    const runtime = await import('./workspace-knowledge-mutation-runtime')
    const unknown = join(tempHome, '.proma', 'agent-workspaces', 'never-created')
    expect(runtime.resolveWorkspaceKnowledgeTarget('never-created', join(unknown, 'memory', 'a.md'))).toBeUndefined()
    expect(existsSync(unknown)).toBe(false)
    expect(runtime.resolveWorkspaceKnowledgeTarget('../../escape-attempt', join(tempHome, 'x', 'a.md'))).toBeUndefined()
  })
})
