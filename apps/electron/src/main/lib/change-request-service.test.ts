/**
 * 变更请求服务测试
 *
 * 覆盖：跨仓库隔离、无 worktree 回退项目根、手动刷新共享 in-flight、
 * gh 不可用降级、会话删除清理、Agent 事件驱动的绑定与刷新。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentStreamPayload,
  ChangeRequestSnapshot,
  ChangeRequestUnavailable,
} from '@proma/shared'
import { ChangeRequestPoller } from './change-request-poller'
import { ChangeRequestService, type ChangeRequestSessionLike, type ChangeRequestWorkspaceLike } from './change-request-service'
import { ChangeRequestStore } from './change-request-store'
import { GitHubChangeRequestError, parseRemoteTarget, type GitHubRepository } from './github-change-request-service'

const tempDirs: string[] = []
const REPO_ONE: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'one' }
const REPO_TWO: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'two' }
const URL_ONE = 'https://github.com/acme/one/pull/11'
const URL_TWO = 'https://github.com/acme/two/pull/22'

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

/** 记录调用并按 cwd 返回仓库的假 GitHub 客户端；不访问网络。 */
class FakeGitHub {
  readonly repositories = new Map<string, GitHubRepository>()
  readonly branches = new Map<string, string | null>()
  readonly upstreams = new Map<string, GitHubRepository>()
  readonly matches = new Map<string, string[]>()
  readonly views = new Map<string, ChangeRequestSnapshot>()
  readonly discoveredCwds: string[] = []
  readonly viewCalls: string[] = []
  viewGate: Promise<void> | null = null
  discoveryError: GitHubChangeRequestError | null = null
  availability: ChangeRequestUnavailable | null = null

  async discoverRepository(cwd: string): Promise<GitHubRepository> {
    this.discoveredCwds.push(cwd)
    if (this.discoveryError) throw this.discoveryError
    const repository = this.repositories.get(cwd)
    if (!repository) {
      throw new GitHubChangeRequestError('当前会话目录不是 Git 仓库，无法关联变更请求。', 'not-git-repository')
    }
    return repository
  }

  async currentBranch(cwd: string): Promise<string | null> {
    return this.branches.get(cwd) ?? null
  }

  async repositoryRoot(cwd: string): Promise<string | null> {
    return cwd
  }

  async upstreamRepositoryOf(cwd: string): Promise<GitHubRepository | null> {
    return this.upstreams.get(cwd) ?? null
  }

  async findByHead(_cwd: string, repository: GitHubRepository, branch: string): Promise<Array<{ repository: GitHubRepository; number: number; url: string }>> {
    const urls = this.matches.get(`${repository.owner}/${repository.name}#${branch}`) ?? []
    return urls.map((url) => ({
      repository,
      number: Number(url.split('/').pop()),
      url,
    }))
  }

  async viewUrlFromHome(url: string): Promise<{ url: string; snapshot: ChangeRequestSnapshot }> {
    this.viewCalls.push(url)
    if (this.viewGate) await this.viewGate
    const snapshotValue = this.views.get(url)
    if (!snapshotValue) throw new Error('缺少测试快照')
    return { url, snapshot: snapshotValue }
  }

  repositoryFromRemote(target: string): GitHubRepository | null {
    return parseRemoteTarget(target)
  }

  async checkAvailability(): Promise<ChangeRequestUnavailable | null> {
    return this.availability
  }
}

interface Harness {
  service: ChangeRequestService
  store: ChangeRequestStore
  github: FakeGitHub
  poller: ChangeRequestPoller
  sessions: Map<string, ChangeRequestSessionLike>
  workspaces: Map<string, ChangeRequestWorkspaceLike>
  changes: string[][]
  root: string
  addSession: (input: {
    id: string
    workspaceId?: string
    worktreePath?: string
  }) => ChangeRequestSessionLike
}

const services: ChangeRequestService[] = []

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'proma-change-request-service-'))
  tempDirs.push(root)
  const store = new ChangeRequestStore(join(root, 'change-requests.json'))
  const github = new FakeGitHub()
  const sessions = new Map<string, ChangeRequestSessionLike>()
  const workspaces = new Map<string, ChangeRequestWorkspaceLike>()
  const changes: string[][] = []
  const poller = new ChangeRequestPoller({
    fetch: async (url) => {
      try {
        const view = await github.viewUrlFromHome(url)
        return { snapshot: view.snapshot }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    settle: (url, result) => {
      const affected: string[] = []
      for (const sessionId of store.listBoundSessions()) {
        const owns = store.list(sessionId).some(
          (binding) => binding.dismissed !== true && binding.url === url,
        )
        if (!owns) continue
        if ('snapshot' in result) store.setSnapshot(sessionId, url, result.snapshot)
        else store.setError(sessionId, url, result.error)
        affected.push(sessionId)
      }
      return affected
    },
  })

  const service = new ChangeRequestService({
    store,
    github,
    poller,
    getSession: (sessionId) => sessions.get(sessionId),
    getWorkspace: (workspaceId) => workspaces.get(workspaceId),
    resolveCwd: (workspace, sessionId) => workspace?.projectRootPath ?? join(root, 'sessions', sessionId),
    onChanged: (sessionIds) => changes.push(sessionIds),
    discoveryDebounceMs: 0,
  })
  services.push(service)

  return {
    service,
    store,
    github,
    poller,
    sessions,
    workspaces,
    changes,
    root,
    addSession: ({ id, workspaceId, worktreePath }) => {
      const session: ChangeRequestSessionLike = {
        id,
        ...(workspaceId ? { workspaceId } : {}),
        ...(worktreePath
          ? {
              activeWorktree: {
                path: worktreePath,
                mainRepoRoot: join(root, 'main'),
                branch: 'feature/login',
                selectedAt: 1,
              },
            }
          : {}),
      }
      sessions.set(id, session)
      return session
    },
  }
}

function assistantPayload(toolUseId: string, command: string): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
      },
      parent_tool_use_id: null,
    },
  }
}

function toolResultPayload(toolUseId: string, content: string): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
      },
      parent_tool_use_id: null,
    },
  }
}

function runCompletedPayload(): AgentStreamPayload {
  return { kind: 'proma_event', event: { type: 'run_completed', source: 'desktop', stoppedByUser: false } }
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ChangeRequestService 仓库作用域', () => {
  test('Given 两个仓库有同名分支，When 各自发现 PR，Then 绑定不会串到另一个仓库', async () => {
    const harness = createHarness()
    const rootOne = join(harness.root, 'repo-one')
    const rootTwo = join(harness.root, 'repo-two')
    mkdirSync(rootOne, { recursive: true })
    mkdirSync(rootTwo, { recursive: true })

    harness.github.repositories.set(rootOne, REPO_ONE)
    harness.github.repositories.set(rootTwo, REPO_TWO)
    harness.github.branches.set(rootOne, 'feature/login')
    harness.github.branches.set(rootTwo, 'feature/login')
    harness.github.matches.set('acme/one#feature/login', [URL_ONE])
    harness.github.matches.set('acme/two#feature/login', [URL_TWO])
    harness.github.views.set(URL_ONE, snapshot())
    harness.github.views.set(URL_TWO, snapshot())

    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: rootOne })
    harness.workspaces.set('ws-two', { slug: 'ws-two', projectRootPath: rootTwo })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.addSession({ id: 'session-two', workspaceId: 'ws-two' })

    await harness.service.discoverSession('session-one')
    await harness.service.discoverSession('session-two')

    expect(harness.store.list('session-one').map((binding) => binding.url)).toEqual([URL_ONE])
    expect(harness.store.list('session-two').map((binding) => binding.url)).toEqual([URL_TWO])
    expect(harness.store.list('session-one')[0]?.number).toBe(11)
    expect(harness.store.list('session-two')[0]?.number).toBe(22)
  })

  test('Given 没有可用 worktree 且项目已授权根目录，When 解析仓库，Then 使用项目根而不是会话工作台', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.branches.set(projectRoot, 'feature/login')
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    const state = await harness.service.get('session-one')

    expect(harness.github.discoveredCwds[0]).toBe(projectRoot)
    expect(state?.scope?.repository).toEqual(REPO_ONE)
    expect(state?.scope?.branch).toBe('feature/login')
    expect(state?.summaries[0]?.repository).toBe('acme/one')
    expect(state?.summaries[0]?.branch).toBe('feature/login')
  })

  test('Given worktree 目录仍存在，When 解析仓库，Then worktree 优先于项目根', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    const worktreePath = join(harness.root, 'worktree')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(worktreePath, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_TWO)
    harness.github.repositories.set(worktreePath, REPO_ONE)
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one', worktreePath })

    await harness.service.get('session-one')

    expect(harness.github.discoveredCwds[0]).toBe(worktreePath)
  })

  test('Given worktree 已被删除，When 解析仓库，Then 回退到项目根', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one', worktreePath: join(harness.root, 'gone') })

    await harness.service.get('session-one')

    expect(harness.github.discoveredCwds[0]).toBe(projectRoot)
  })
})

describe('ChangeRequestService 刷新与降级', () => {
  test('Given 后台轮询已在读取同一 PR，When 手动刷新，Then 复用同一请求而不重复调用 gh', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.branches.set(projectRoot, 'feature/login')
    harness.github.views.set(URL_ONE, snapshot({ title: '来自后端' }))
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    let release: () => void = () => {}
    harness.github.viewGate = new Promise<void>((resolve) => {
      release = resolve
    })

    harness.service.handleAgentEvent('session-one', runCompletedPayload())
    expect(harness.github.viewCalls).toEqual([URL_ONE])

    const manual = harness.service.refresh('session-one')
    await Bun.sleep(5)
    expect(harness.github.viewCalls).toEqual([URL_ONE])

    release()
    const result = await manual

    expect(result.error).toBeUndefined()
    expect(harness.github.viewCalls).toEqual([URL_ONE])
    expect(harness.store.list('session-one')[0]?.snapshot?.title).toBe('来自后端')
  })

  test('Given gh 未安装但仓库可解析，When 读取会话状态，Then 显示不可用原因且不改动已有绑定', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.branches.set(projectRoot, 'feature/login')
    harness.github.availability = { reason: 'gh-missing', message: '找不到 gh，请安装并确保它在 PATH 中。' }
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    const state = await harness.service.get('session-one')

    expect(state?.unavailable?.reason).toBe('gh-missing')
    expect(state?.unavailable?.message).toContain('找不到 gh')
    expect(state?.scope?.repository).toEqual(REPO_ONE)
    expect(state?.summaries[0]?.number).toBe(11)
  })

  test('Given 轮次结束，When 处理 Agent 事件，Then 立即刷新已有绑定', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.views.set(URL_ONE, snapshot({ state: 'MERGED' }))
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    harness.service.handleAgentEvent('session-one', runCompletedPayload())
    await Bun.sleep(5)

    expect(harness.github.viewCalls).toContain(URL_ONE)
    expect(harness.store.list('session-one')[0]?.snapshot?.state).toBe('MERGED')
  })

  test('Given 绑定属于已不存在的会话，When 同步轮询，Then 自动清理该会话的绑定与订阅', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('ghost-session', [URL_ONE], 'discovered')

    await harness.service.refresh('session-one')

    expect(harness.store.list('ghost-session')).toEqual([])
    expect(harness.poller.watchedUrls()).toEqual([])
  })

  test('Given 会话被删除，When 清理，Then 绑定与轮询订阅一并移除', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')
    await harness.service.refresh('session-one')
    expect(harness.poller.watchedUrls()).toEqual([URL_ONE])

    harness.service.onSessionDeleted('session-one')

    expect(harness.store.list('session-one')).toEqual([])
    expect(harness.poller.watchedUrls()).toEqual([])
    expect(await harness.poller.refreshSession('session-one')).toEqual([])
  })
})

describe('ChangeRequestService 观察 Agent 输出', () => {
  test('Given Agent 引用了当前仓库的 PR，When 处理工具结果，Then 自动绑定并刷新', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.branches.set(projectRoot, 'feature/login')
    harness.github.views.set(URL_ONE, snapshot({ title: '引用到的 PR' }))
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })

    harness.service.handleAgentEvent('session-one', assistantPayload('tool-1', `gh pr view ${URL_ONE}`))
    harness.service.handleAgentEvent('session-one', toolResultPayload('tool-1', `url: ${URL_ONE}`))
    await Bun.sleep(10)

    const bindings = harness.store.list('session-one')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.url).toBe(URL_ONE)
    expect(bindings[0]?.source).toBe('referenced')
    expect(bindings[0]?.snapshot?.title).toBe('引用到的 PR')
    expect(harness.changes).toContainEqual(['session-one'])
  })

  test('Given Agent 引用了其它仓库的 PR，When 处理工具结果，Then 不写入绑定', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })

    harness.service.handleAgentEvent('session-one', assistantPayload('tool-1', `gh pr view ${URL_TWO}`))
    harness.service.handleAgentEvent('session-one', toolResultPayload('tool-1', `url: ${URL_TWO}`))
    await Bun.sleep(10)

    expect(harness.store.list('session-one')).toEqual([])
  })

  test('Given 仓库归属未知，When 处理 PR 引用，Then 不臆测归属', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.discoveryError = new GitHubChangeRequestError('origin 不是受支持的 GitHub 远端。', 'no-github-remote')
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })

    harness.service.handleAgentEvent('session-one', assistantPayload('tool-1', `gh pr view ${URL_ONE}`))
    harness.service.handleAgentEvent('session-one', toolResultPayload('tool-1', `url: ${URL_ONE}`))
    await Bun.sleep(10)

    expect(harness.store.list('session-one')).toEqual([])
  })

  test('Given gh pr create 输出 PR 链接，When 处理工具结果，Then 绑定为本轮创建的 PR', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.discoveryError = new GitHubChangeRequestError('当前仓库没有 origin 远端。', 'no-github-remote')
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })

    harness.service.handleAgentEvent('session-one', assistantPayload('tool-1', 'gh pr create --fill'))
    harness.service.handleAgentEvent('session-one', toolResultPayload('tool-1', `url: ${URL_ONE}\nstate: OPEN`))
    await Bun.sleep(10)

    const bindings = harness.store.list('session-one')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.source).toBe('created')
  })

  test('Given git push 输出分支，When 处理工具结果，Then 按当前仓库发现并绑定 PR', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.branches.set(projectRoot, 'feature/login')
    harness.github.matches.set('acme/one#feature/login', [URL_ONE])
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })

    harness.service.handleAgentEvent('session-one', assistantPayload('tool-1', 'git push origin HEAD:feature/login'))
    harness.service.handleAgentEvent(
      'session-one',
      toolResultPayload('tool-1', 'To git@github.com:acme/one.git\n   abc1234..def5678  feature/login -> feature/login'),
    )
    await Bun.sleep(20)

    const bindings = harness.store.list('session-one')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.url).toBe(URL_ONE)
    expect(bindings[0]?.source).toBe('discovered')
  })
})

describe('ChangeRequestService 操作', () => {
  test('Given 会话已绑定 PR，When open，Then 返回链接；When dismiss，Then 摘要清空', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    const opened = await harness.service.action({ sessionId: 'session-one', action: 'open' })
    expect(opened.openedUrl).toBe(URL_ONE)

    const dismissed = await harness.service.action({ sessionId: 'session-one', action: 'dismiss', url: URL_ONE })
    expect(dismissed.session.summaries).toEqual([])
    expect(harness.store.list('session-one')[0]?.dismissed).toBe(true)
  })

  test('Given 多个会话有绑定，When list，Then 只返回有绑定的会话', async () => {
    const harness = createHarness()
    const projectRoot = join(harness.root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    harness.github.repositories.set(projectRoot, REPO_ONE)
    harness.github.views.set(URL_ONE, snapshot())
    harness.workspaces.set('ws-one', { slug: 'ws-one', projectRootPath: projectRoot })
    harness.addSession({ id: 'session-one', workspaceId: 'ws-one' })
    harness.addSession({ id: 'session-empty', workspaceId: 'ws-one' })
    harness.store.merge('session-one', [URL_ONE], 'discovered')

    const result = await harness.service.list()

    expect(result.sessions.map((state) => state.sessionId)).toEqual(['session-one'])
    expect(result.sessions[0]?.summaries[0]?.number).toBe(11)
  })
})
