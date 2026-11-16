import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'proma-knowledge-target-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

let approved = true
// 只替换路径与授权查询；分类、实体解析和见证读取使用真实实现。
mock.module('./config-paths', () => ({
  resolveAgentWorkspaceDirPath: (slug: string) => join(root, 'workspaces', slug),
}))
const grants: string[] = []
mock.module('./agent-workspace-manager', () => ({
  resolveWorkspaceProjectRoot: (slug: string) => join(root, 'projects', slug),
  getKnownKnowledgeWorkspace: (slug: string) => {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('非法工作区标识')
    if (slug !== 'demo') throw new Error('工作区不存在')
    return { id: 'demo', slug, name: 'demo', createdAt: 1, updatedAt: 1 }
  },
  isWorkspaceProjectKnowledgeMaintenanceApproved: () => approved,
  // 归因必须消费与读写/树/watch相同的权限策略；测试用合成授权列表驱动。
  getWorkspaceKnowledgePolicy: (slug: string, kind: 'memory' | 'workspace_agents' | 'project_agents' = 'memory') => {
    const workspaceDir = join(root, 'workspaces', slug)
    const anchor = kind === 'project_agents' ? join(root, 'projects', slug) : workspaceDir
    return { anchor, logicalRoot: kind === 'memory' ? join(workspaceDir, 'memory') : anchor, authorizedDirectories: [...grants] }
  },
}))

const { resolveWorkspaceKnowledgeTarget, configureWorkspaceKnowledgeAttribution, bindWorkspaceKnowledgeScope } = await import('./workspace-knowledge-mutation-runtime')

function write(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}
const workspaceDir = join(root, 'workspaces', 'demo')
const memoryFile = write(join(workspaceDir, 'memory', 'notes', 'a.md'), '记忆')
const workspaceAgents = write(join(workspaceDir, 'AGENTS.md'), '规则')
const projectAgents = write(join(root, 'projects', 'demo', 'AGENTS.md'), '项目规则')
const outside = write(join(root, 'outside', 'secret.md'), '外部')
const otherProjectFile = write(join(root, 'projects', 'demo', 'src', 'index.ts'), 'code')

describe('知识目标分类与授权边界', () => {
  test('Given memory 内文件 When 分类 Then 相对路径以正斜杠表示且物理键独立于逻辑路径', () => {
    const target = resolveWorkspaceKnowledgeTarget('demo', memoryFile)
    expect(target?.file).toEqual({ kind: 'memory', relativePath: 'notes/a.md' })
    expect(target?.key.replace(/\\/g, '/')).toContain('/memory/notes/a.md')
    expect(typeof target?.boundaryIdentity).toBe('string')
  })

  test('Given 尚未创建的 memory 文件 When 分类 Then 可归因但链接目录不得带出授权根', () => {
    const missing = join(workspaceDir, 'memory', 'notes', 'new.md')
    expect(resolveWorkspaceKnowledgeTarget('demo', missing)?.file).toEqual({ kind: 'memory', relativePath: 'notes/new.md' })
    // 尚不存在的多级目录仍由物理祖先推导；若祖先被链接到外部则必须拒绝。
    const escapedDir = join(workspaceDir, 'memory', 'linked')
    try { symlinkSync(join(root, 'outside'), escapedDir) } catch { return }
    expect(resolveWorkspaceKnowledgeTarget('demo', join(escapedDir, 'new.md'))).toBeUndefined()
  })

  test('Given 两份 AGENTS When 已获维护授权 Then 区分工作区规则与项目规则', () => {
    approved = true
    expect(resolveWorkspaceKnowledgeTarget('demo', workspaceAgents)?.file).toEqual({ kind: 'workspace_agents' })
    expect(resolveWorkspaceKnowledgeTarget('demo', projectAgents)?.file).toEqual({ kind: 'project_agents' })
  })

  test('Given 未获维护授权 When 碰 AGENTS Then 仍保留竞争目标但不自动展示来源', () => {
    approved = false
    const target = resolveWorkspaceKnowledgeTarget('demo', workspaceAgents)
    expect(target).toBeDefined()
    expect(target?.file).toBeUndefined()
    approved = true
  })

  test('Given 项目普通源码或项目根外文件 When 分类 Then 不是知识目标', () => {
    expect(resolveWorkspaceKnowledgeTarget('demo', otherProjectFile)).toBeUndefined()
    expect(resolveWorkspaceKnowledgeTarget('demo', outside)).toBeUndefined()
    expect(resolveWorkspaceKnowledgeTarget('demo', 'memory/a.md')).toBeUndefined()
  })

  test('Given memory 内链接指向外部 When 分类 Then 不跟随且不扩权', () => {
    const link = join(workspaceDir, 'memory', 'escape.md')
    try { symlinkSync(outside, link) } catch { return }
    expect(resolveWorkspaceKnowledgeTarget('demo', link)).toBeUndefined()
  })

  test('Given 未知工作区 When 分类 Then 不猜测目标', () => {
    expect(resolveWorkspaceKnowledgeTarget('missing-workspace', memoryFile)).toBeUndefined()
  })
})


test('Given 已授权外置目录 When 经memory链接写入 Then 归因为memory且物理键是外置真实目标', () => {
  const external = join(root, 'authorized-external', 'notes')
  write(join(external, 'shared.md'), '外部记忆')
  const link = join(workspaceDir, 'memory', 'linked')
  try { symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir') } catch { return }
  // 未授权时不归因，避免把外部正文当作memory来源。
  expect(resolveWorkspaceKnowledgeTarget('demo', join(link, 'shared.md'))).toBeUndefined()
  grants.push(realpathSync(external))
  try {
    const target = resolveWorkspaceKnowledgeTarget('demo', join(link, 'shared.md'))
    expect(target?.file).toEqual({ kind: 'memory', relativePath: 'linked/shared.md' })
    expect(target?.key).toContain('authorized-external')
    expect(target?.key).toContain('shared.md')
    expect(typeof target?.boundaryIdentity).toBe('string')
  } finally { grants.length = 0 }
})

test('Given 已授权文件链接 When 观察器写入 Then witness使用真实目标以保留归因资格', async () => {
  const external = join(root, 'link-target')
  write(join(external, 'real.md'), '链接前')
  const policyAnchor = join(workspaceDir, 'memory')
  const alias = join(policyAnchor, 'alias.md')
  try { mkdirSync(join(external), { recursive: true }); symlinkSync(join(external, 'real.md'), alias) } catch { return }
  grants.push(realpathSync(external))
  try {
    const target = resolveWorkspaceKnowledgeTarget('demo', alias)
    expect(target?.file).toEqual({ kind: 'memory', relativePath: 'alias.md' })
    // 逻辑路径是链接，真实目标是普通文件；见证必须走 physicalPath。
    expect(target?.physicalPath?.toLowerCase()).toContain('real.md')
    expect(target?.key.toLowerCase()).toContain('real.md')
    const observer = bindWorkspaceKnowledgeScope({ sessionId: 'link-session', runGeneration: 1, queryId: 'link-q', workspaceId: 'link-ws', workspaceSlug: 'demo' })
    try {
      expect(typeof observer.resolveWitnessPath).toBe('function')
      const mapped = observer.resolveWitnessPath?.(alias)
      expect(mapped ? mapped.toLowerCase().includes('real.md') : false).toBe(true)
    } finally { observer.close() }
  } finally { grants.length = 0 }
})

test('Given Agent来源票据 When 手动writer保存同一物理文件 Then 不能把手动内容归给Agent', async () => {
  const { writeKnowledgeFileAtomic } = await import('./knowledge-file-write')
  const { readKnowledgeWitness } = await import('./knowledge-witness')
  const events: unknown[] = []
  configureWorkspaceKnowledgeAttribution({ isRunCurrent: () => true, emit: (event) => { events.push(event) } })
  const observer = bindWorkspaceKnowledgeScope({ sessionId: 'manual-A', runGeneration: 1, queryId: 'manual-q', workspaceId: 'manual-ws', workspaceSlug: 'demo' })
  try {
    const before = readKnowledgeWitness(memoryFile)
    const ticket = await observer.begin({ toolName: 'write', toolCallId: 'manual-tool', path: memoryFile })
    expect(ticket?.candidate).toBe(true)
    writeKnowledgeFileAtomic({ allowedRoot: join(workspaceDir, 'memory'), filePath: memoryFile, content: '用户手动修改', expectedContent: before.text, maxBytes: 10_000 })
    const after = readKnowledgeWitness(memoryFile)
    if (!ticket) throw new Error('fixture ticket missing')
    await observer.finish({ ticketId: ticket.ticketId, toolCallId: 'manual-tool', outcome: 'success', writeCount: 1,
      sdkRead: before.witness, preWrite: before.witness, observedAfter: after.witness,
      expectedAfterBytes: after.witness.byteLength, expectedAfterSha256: after.witness.sha256 })
    expect(events).toEqual([])
  } finally {
    observer.close()
    configureWorkspaceKnowledgeAttribution(undefined)
  }
})
