import { afterAll, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertKnowledgeResolutionUnchanged, resolveWorkspaceKnowledgePath, type KnowledgeAccessPolicy } from './workspace-knowledge-access'

const temporary = mkdtempSync(join(tmpdir(), 'proma-knowledge-access-'))
const anchor = join(temporary, 'workspace')
const memory = join(anchor, 'memory')
const external = join(temporary, 'external')
const third = join(temporary, 'third')
for (const path of [memory, external, third]) mkdirSync(path, { recursive: true })
const canonical = (path: string): string => realpathSync(path)
const root = canonical(anchor)
const grants: string[] = []
const policy = (): KnowledgeAccessPolicy => ({ anchor: root, logicalRoot: join(root, 'memory'), authorizedDirectories: [...grants] })
writeFileSync(join(memory, 'normal.md'), '普通记忆')
writeFileSync(join(external, 'a.md'), '外置记忆')
writeFileSync(join(third, 'secret.md'), '第三目录')
afterAll(() => { rmSync(temporary, { recursive: true, force: true }) })
function directoryLink(target: string, path: string): void { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir') }

describe('统一知识路径与逐跳授权', () => {
  test('Given 普通文件和缺失后代 When 解析 Then 不读正文且保留逻辑路径及最近祖先', () => {
    const found = resolveWorkspaceKnowledgePath(policy(), 'normal.md')
    expect(found.kind).toBe('file')
    expect(found.physicalPath).toBe(canonical(join(memory, 'normal.md')))
    expect(found.linked).toBe(false)
    const missing = resolveWorkspaceKnowledgePath(policy(), 'new/deep.md', { allowMissing: true })
    expect(missing.kind).toBe('missing')
    expect(missing.physicalPath).toBe(join(root, 'memory', 'new', 'deep.md'))
    expect(() => resolveWorkspaceKnowledgePath(policy(), 'new/deep.md')).toThrow()
  })

  test('Given 未授权目录链接 When 解析 Then 读取link本身后不触碰外部目标', () => {
    directoryLink(external, join(memory, 'outside'))
    const inspected: string[] = []
    const io = { lstat: (path: string) => { inspected.push(path); return lstatSync(path) }, realpath: (path: string) => { inspected.push(path); return realpathSync(path) }, readlink: readlinkSync }
    expect(() => resolveWorkspaceKnowledgePath({ ...policy(), fileSystem: io }, 'outside/a.md')).toThrow('授权')
    expect(inspected.some(path => path.startsWith(canonical(external)))).toBe(false)
    expect(readlinkSync(join(memory, 'outside'))).toBeTruthy()
  })

  test('Given 显式外置目录授权 When 经链接读取 Then 使用外置限定根而非公共祖先', () => {
    grants.push(canonical(external))
    const found = resolveWorkspaceKnowledgePath(policy(), 'outside/a.md')
    expect(found.linked).toBe(true)
    expect(found.allowedRoot).toBe(canonical(external))
    expect(found.logicalPath).toBe(join(root, 'memory', 'outside', 'a.md'))
    expect(readFileSync(found.physicalPath, 'utf8')).toBe('外置记忆')
    directoryLink(third, join(external, 'next'))
    expect(() => resolveWorkspaceKnowledgePath(policy(), 'outside/next/secret.md')).toThrow('授权')
  })

  test('Given 撤销或授权目录同名换为链接 When 再解析 Then 旧授权不自动转移', () => {
    const old = resolveWorkspaceKnowledgePath(policy(), 'outside/a.md')
    grants.length = 0
    expect(() => resolveWorkspaceKnowledgePath(policy(), 'outside/a.md')).toThrow('授权')
    grants.push(canonical(external))
    renameSync(external, `${external}-original`)
    directoryLink(third, external)
    try { expect(() => resolveWorkspaceKnowledgePath(policy(), 'outside/secret.md')).toThrow('授权') } finally {
      unlinkSync(external); renameSync(`${external}-original`, external)
    }
    const current = resolveWorkspaceKnowledgePath(policy(), 'outside/a.md')
    expect(() => assertKnowledgeResolutionUnchanged(old, current)).not.toThrow()
  })

  test('Given 根memory本身为链接 When 无grant/有grant Then 同策略拒绝/放行且保留根链接', () => {
    const linkedAnchor = join(temporary, 'linked-workspace')
    mkdirSync(linkedAnchor)
    directoryLink(external, join(linkedAnchor, 'memory'))
    const linkedPolicy = { anchor: canonical(linkedAnchor), logicalRoot: join(canonical(linkedAnchor), 'memory'), authorizedDirectories: [] }
    expect(() => resolveWorkspaceKnowledgePath(linkedPolicy, 'a.md')).toThrow('授权')
    expect(resolveWorkspaceKnowledgePath({ ...linkedPolicy, authorizedDirectories: [canonical(external)] }, 'a.md').kind).toBe('file')
    expect(lstatSync(join(linkedAnchor, 'memory')).isSymbolicLink()).toBe(true)
  })

  test('Given 根内目录别名与循环 When 解析 Then 内部别名可达而循环与断链不当新文件', () => {
    mkdirSync(join(memory, 'real'))
    writeFileSync(join(memory, 'real', 'a.md'), '内部')
    directoryLink(join(memory, 'real'), join(memory, 'alias'))
    expect(resolveWorkspaceKnowledgePath(policy(), 'alias/a.md').physicalPath).toBe(canonical(join(memory, 'real', 'a.md')))
    directoryLink(join(memory, 'cycle-b'), join(memory, 'cycle-a'))
    directoryLink(join(memory, 'cycle-a'), join(memory, 'cycle-b'))
    expect(() => resolveWorkspaceKnowledgePath(policy(), 'cycle-a/file.md', { allowMissing: true })).toThrow()
    directoryLink(join(memory, 'absent'), join(memory, 'broken'))
    expect(() => resolveWorkspaceKnowledgePath(policy(), 'broken/new.md', { allowMissing: true })).toThrow('断')
  })

  test('Given 路径穿越和Windows别名 When 解析 Then 不接收绝对/设备/ADS/空段路径', () => {
    for (const path of ['../secret.md', '/tmp/a', 'C:relative.md', 'C:/absolute.md', '\\server\\share', 'a/../b', 'a\\..\\b', 'a\u0000b', 'a.md:stream', 'a//b']) {
      expect(() => resolveWorkspaceKnowledgePath(policy(), path)).toThrow()
    }
    expect(() => resolveWorkspaceKnowledgePath(policy(), '')).toThrow()
    expect(resolveWorkspaceKnowledgePath(policy(), '', { allowRoot: true }).kind).toBe('directory')
  })

  test('Given 准备后父目录或逻辑链接替换 When 提交复验 Then 拒绝而不是改到新目标', () => {
    const before = resolveWorkspaceKnowledgePath(policy(), 'alias/a.md')
    unlinkSync(join(memory, 'alias'))
    directoryLink(external, join(memory, 'alias'))
    expect(() => assertKnowledgeResolutionUnchanged(before, resolveWorkspaceKnowledgePath(policy(), 'alias/a.md'))).toThrow('变化')
  })
})

test('Given grant祖先改成junction When 验证授权根 Then 在父link处拒绝且不取得其新后代身份', () => {
  const parent = join(temporary, 'grant-parent'), savedParent = `${parent}-saved`, unauthorized = join(temporary, 'unauthorized-parent')
  mkdirSync(join(parent, 'grant'), { recursive: true }); mkdirSync(join(unauthorized, 'grant'), { recursive: true })
  const grant = canonical(join(parent, 'grant'))
  directoryLink(grant, join(memory, 'ancestor-grant'))
  renameSync(parent, savedParent); directoryLink(unauthorized, parent)
  const inspected: string[] = []
  const io = { lstat: (path: string) => { inspected.push(path); return lstatSync(path) }, realpath: realpathSync, readlink: readlinkSync }
  try {
    expect(() => resolveWorkspaceKnowledgePath({ ...policy(), authorizedDirectories: [grant], fileSystem: io }, 'ancestor-grant/a.md')).toThrow('授权')
    expect(inspected).not.toContain(grant)
  } finally { unlinkSync(parent); renameSync(savedParent, parent) }
})
