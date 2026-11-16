/**
 * 会话变更请求服务
 *
 * 组合 store + gh + poller + observer，向 IPC 暴露 list/get/refresh/action。
 *
 * 设计要点：
 * - 作用域（仓库身份 + 分支）从会话真实 cwd 解析：已存在的 worktree 优先，
 *   否则回退到已授权的项目根；再退到会话默认 cwd（仅当它本身就是仓库时才会成功）。
 * - 发现与观察到的 PR 都必须通过仓库归属过滤；未知仓库时不臆测归属。
 * - 手动刷新调用 `poller.refreshSession`，与后台轮询共享同一个 in-flight promise。
 */

import { existsSync, statSync } from 'node:fs'
import type {
  AgentActiveWorktree,
  AgentCwdMode,
  AgentStreamPayload,
  ChangeRequestActionInput,
  ChangeRequestActionResult,
  ChangeRequestBinding,
  ChangeRequestBindingSource,
  ChangeRequestListResult,
  ChangeRequestScope,
  ChangeRequestSessionState,
  ChangeRequestSnapshot,
  ChangeRequestUnavailable,
  ChangeRequestUnavailableReason,
} from '@proma/shared'
import {
  changeRequestBindingRepositoryKey,
  changeRequestRepositoryKey,
  normalizeChangeRequestUrl,
  parseChangeRequestUrl,
  toChangeRequestSummary,
} from '@proma/shared'
import { ChangeRequestPoller, type ChangeRequestPollResult } from './change-request-poller'
import { ChangeRequestStore, type ChangeRequestStoreMutation } from './change-request-store'
import {
  PendingCommandTracker,
  commandFromToolInput,
  extractChangeRequestUrls,
  isPullRequestCreateCommand,
  isPullRequestReferenceCommand,
  isPushCommand,
  isShellToolName,
  ownChangeRequestUrlFromOutput,
  pushedBranchesFromOutput,
  selectedChangeRequestUrls,
  textOfToolResult,
} from './change-request-observer'
import type {
  GitHubChangeRequestMatch,
  GitHubChangeRequestView,
  GitHubRepository,
} from './github-change-request-service'
import { GitHubChangeRequestError } from './github-change-request-service'

/** 一次 list 最多解析的会话数，避免侧栏一次刷新打爆 git 子进程。 */
const MAX_LIST_SESSIONS = 100
/** 作用域缓存 TTL：侧栏反复挂载时不重复跑 git。 */
const DEFAULT_SCOPE_TTL_MS = 60_000
/** 轮次结束后延迟发现，等 Agent 收尾完成。 */
const DEFAULT_DISCOVERY_DEBOUNCE_MS = 5_000

/** 服务依赖的会话最小形状。 */
export interface ChangeRequestSessionLike {
  id: string
  workspaceId?: string
  agentCwdMode?: AgentCwdMode
  activeWorktree?: AgentActiveWorktree
}

/** 服务依赖的工作区最小形状。 */
export interface ChangeRequestWorkspaceLike {
  slug: string
  projectRootPath?: string
}

/** 存储接口；测试可传入真实 ChangeRequestStore 或内存实现。 */
export interface ChangeRequestStoreLike {
  list(sessionId: string): ChangeRequestBinding[]
  listBoundSessions(): string[]
  merge(
    sessionId: string,
    urls: readonly string[],
    source: ChangeRequestBindingSource,
    accept?: (url: string) => boolean,
    now?: number,
  ): ChangeRequestStoreMutation
  setSnapshot(sessionId: string, url: string, snapshot: ChangeRequestSnapshot, now?: number): boolean
  setError(sessionId: string, url: string, error: string, now?: number): boolean
  dismiss(sessionId: string, url: string, now?: number): ChangeRequestStoreMutation
  removeSession(sessionId: string): boolean
}

/** GitHub 客户端接口；测试用假实现替换，不访问网络。 */
export interface GitHubChangeRequestClientLike {
  discoverRepository(cwd: string): Promise<GitHubRepository>
  currentBranch(cwd: string): Promise<string | null>
  repositoryRoot(cwd: string): Promise<string | null>
  upstreamRepositoryOf(cwd: string, repository: GitHubRepository): Promise<GitHubRepository | null>
  findByHead(cwd: string, repository: GitHubRepository, branch: string): Promise<GitHubChangeRequestMatch[]>
  viewUrlFromHome(url: string): Promise<GitHubChangeRequestView>
  repositoryFromRemote(target: string): GitHubRepository | null
  /** 检查 gh 是否可执行；可用时返回 null。 */
  checkAvailability(): Promise<ChangeRequestUnavailable | null>
}

export interface ChangeRequestServiceDeps {
  store: ChangeRequestStoreLike
  github: GitHubChangeRequestClientLike
  getSession: (sessionId: string) => ChangeRequestSessionLike | undefined
  getWorkspace: (workspaceId: string) => ChangeRequestWorkspaceLike | undefined
  /** 与 agent-session-manager 的 resolveAgentCwd 同签名；作为最后兜底。 */
  resolveCwd: (
    workspace: ChangeRequestWorkspaceLike | undefined,
    sessionId: string,
    agentCwdMode?: AgentCwdMode,
    activeWorktree?: AgentActiveWorktree,
  ) => string | undefined
  /** 状态变化推送给渲染层。 */
  onChanged?: (sessionIds: string[]) => void
  now?: () => number
  scopeTtlMs?: number
  discoveryDebounceMs?: number
  poller?: ChangeRequestPoller
  log?: (message: string, error?: unknown) => void
}

interface ScopeResolution {
  cwd: string | null
  scope: ChangeRequestScope | null
  unavailable?: ChangeRequestUnavailable
}

interface ScopeCacheEntry extends ScopeResolution {
  at: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function repositoryKeyOf(repository: GitHubRepository | undefined): string | null {
  return repository ? changeRequestRepositoryKey(repository) : null
}

function unavailableFrom(error: unknown): ChangeRequestUnavailable {
  if (error instanceof GitHubChangeRequestError) {
    return { reason: error.reason, message: error.message }
  }
  const record = asRecord(error)
  const reason = record?.reason
  if (typeof reason === 'string') {
    return { reason: reason as ChangeRequestUnavailableReason, message: error instanceof Error ? error.message : String(error) }
  }
  return {
    reason: 'failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

export class ChangeRequestService {
  private readonly deps: ChangeRequestServiceDeps
  private readonly store: ChangeRequestStoreLike
  private readonly github: GitHubChangeRequestClientLike
  private readonly poller: ChangeRequestPoller
  private readonly pendingCommands = new PendingCommandTracker()
  private readonly scopeCache = new Map<string, ScopeCacheEntry>()
  private readonly scopeInFlight = new Map<string, Promise<ScopeResolution>>()
  private readonly discoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** gh 可用性是进程级结论，无需按会话重复探测。 */
  private availabilityCache: { at: number; value: ChangeRequestUnavailable | null } | null = null
  private readonly scopeTtlMs: number
  private readonly discoveryDebounceMs: number
  private initialized = false
  private disposed = false

  constructor(deps: ChangeRequestServiceDeps) {
    this.deps = deps
    this.store = deps.store
    this.github = deps.github
    this.scopeTtlMs = deps.scopeTtlMs ?? DEFAULT_SCOPE_TTL_MS
    this.discoveryDebounceMs = deps.discoveryDebounceMs ?? DEFAULT_DISCOVERY_DEBOUNCE_MS
    this.poller = deps.poller ?? new ChangeRequestPoller({
      fetch: (url) => this.fetchUrl(url),
      settle: (url, result) => this.settleUrl(url, result),
      notify: (sessionIds) => this.notify(sessionIds),
    })
  }

  /** 启动：按已存绑定重建轮询订阅，并清理不属于当前仓库的旧绑定。 */
  initialize(): void {
    if (this.initialized || this.disposed) return
    this.initialized = true
    this.syncPoller()
    void this.poller.pollDue()
    void this.sweepForeignBindings()
  }

  /** 返回所有存在绑定的会话；传入 sessionIds 时只返回这些会话。 */
  async list(sessionIds?: readonly string[]): Promise<ChangeRequestListResult> {
    const ids = sessionIds && sessionIds.length > 0
      ? [...new Set(sessionIds)]
      : this.store.listBoundSessions()
    const sessions: ChangeRequestSessionState[] = []
    for (const sessionId of ids.slice(0, MAX_LIST_SESSIONS)) {
      const state = await this.get(sessionId)
      if (state) sessions.push(state)
    }
    return { sessions }
  }

  /** 单个会话的状态；会话不存在时 null。 */
  async get(sessionId: string): Promise<ChangeRequestSessionState | null> {
    const session = this.deps.getSession(sessionId)
    if (!session) return null
    const resolution = await this.resolveScope(sessionId)
    return this.buildState(sessionId, resolution)
  }

  /** 立即刷新（与后台轮询共享 in-flight）；可选只刷新一条链接。 */
  async refresh(sessionId: string, url?: string): Promise<ChangeRequestActionResult> {
    const session = this.deps.getSession(sessionId)
    if (!session) throw new Error('会话不存在')

    const normalized = url === undefined ? undefined : (normalizeChangeRequestUrl(url) ?? undefined)
    if (url !== undefined && !normalized) throw new Error('请输入当前 GitHub host 的变更请求链接。')

    // 作用域可能因切换 worktree 变化；显式刷新时强制重新解析。
    await this.resolveScope(sessionId, { force: true })
    this.syncPoller()
    const results = await this.poller.refreshSession(sessionId, normalized)
    const error = firstError(results)
    const state = await this.get(sessionId)
    return {
      session: state ?? this.emptyState(sessionId),
      ...(error ? { error } : {}),
    }
  }

  /** 会话级操作：打开 / 刷新 / 隐藏。 */
  async action(input: ChangeRequestActionInput): Promise<ChangeRequestActionResult> {
    const session = this.deps.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')

    switch (input.action) {
      case 'open': {
        const normalized = this.resolveTargetUrl(input.sessionId, input.url)
        const state = await this.get(input.sessionId)
        return {
          session: state ?? this.emptyState(input.sessionId),
          openedUrl: normalized,
        }
      }
      case 'refresh':
        return this.refresh(input.sessionId, input.url)
      case 'dismiss': {
        const normalized = normalizeChangeRequestUrl(input.url ?? '')
        if (!normalized) throw new Error('请输入当前 GitHub host 的变更请求链接。')
        this.store.dismiss(input.sessionId, normalized, this.now())
        this.syncPoller()
        this.notify([input.sessionId])
        const state = await this.get(input.sessionId)
        return { session: state ?? this.emptyState(input.sessionId) }
      }
      default:
        throw new Error('变更请求操作无效')
    }
  }

  /** 会话被删除：取消轮询、清缓存与定时器。 */
  onSessionDeleted(sessionId: string): void {
    this.clearDiscoveryTimer(sessionId)
    this.scopeCache.delete(sessionId)
    this.scopeInFlight.delete(sessionId)
    try {
      this.store.removeSession(sessionId)
    } catch (error) {
      this.log('清理会话绑定失败', error)
    }
    this.poller.removeSession(sessionId)
  }

  /** 应用退出：停掉全部定时器与订阅。 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.discoveryTimers.values()) clearTimeout(timer)
    this.discoveryTimers.clear()
    this.scopeCache.clear()
    this.scopeInFlight.clear()
    this.availabilityCache = null
    this.pendingCommands.clear()
    this.poller.dispose()
  }

  /**
   * 处理 Agent 事件。
   *
   * - 工具调用：记录 shell 命令，识别 `gh pr view/edit/checkout` 里显式引用的 PR
   * - 工具结果：`gh pr create` 输出绑定 PR；`git push` 输出按分支发现 PR
   * - 轮次结束：立即刷新已有绑定，并（去抖）按当前分支发现新 PR
   */
  handleAgentEvent(sessionId: string, payload: AgentStreamPayload): void {
    if (this.disposed) return
    try {
      if (payload.kind === 'sdk_message') {
        this.handleSdkMessage(sessionId, payload.message)
        return
      }
      if (payload.kind === 'proma_event') {
        const event = payload.event
        if (event.type === 'run_completed' || event.type === 'run_stopped') {
          // 轮次结束前先校准订阅，保证刚写入的绑定也能立即刷新。
          this.syncPoller()
          void this.poller.refreshSession(sessionId).catch((error) => {
            this.log('轮次结束后刷新变更请求失败', error)
          })
          this.scheduleDiscovery(sessionId)
        }
      }
    } catch (error) {
      this.log('处理 Agent 事件失败', error)
    }
  }

  /** 按当前分支发现 open PR；返回错误说明（成功或无需发现时 undefined）。 */
  async discoverSession(sessionId: string): Promise<string | undefined> {
    const resolution = await this.resolveScope(sessionId, { force: true })
    const scope = resolution.scope
    if (!scope || !scope.branch) return resolution.unavailable?.message

    try {
      const matches = await this.github.findByHead(scope.cwd, scope.repository, scope.branch)
      const accept = this.scopeAccept(scope, false)
      const urls = matches.map((match) => match.url).filter((url) => accept(url))
      if (urls.length > 0) await this.applyObservedBindings(sessionId, urls, 'discovered')
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** 重新同步轮询成员关系；绑定变化后必须调用。 */
  private syncPoller(): void {
    const sessions: Array<{ sessionId: string; urls: string[] }> = []
    for (const sessionId of this.store.listBoundSessions()) {
      if (!this.deps.getSession(sessionId)) {
        // 兜底：非 IPC 删除路径（如清理自动化历史会话）也要停掉轮询并移除绑定。
        this.onSessionDeleted(sessionId)
        continue
      }
      const urls = this.store.list(sessionId)
        .filter((binding) => binding.dismissed !== true)
        .map((binding) => binding.url)
      if (urls.length > 0) sessions.push({ sessionId, urls })
    }
    this.poller.sync(sessions)
  }

  /** 解析会话作用域：已存在的 worktree → 项目根 → 默认 cwd。 */
  private resolveSessionCwd(session: ChangeRequestSessionLike): string | null {
    const worktreePath = session.activeWorktree?.path
    if (worktreePath && existsSync(worktreePath) && isDirectory(worktreePath)) return worktreePath

    const workspace = session.workspaceId ? this.deps.getWorkspace(session.workspaceId) : undefined
    if (workspace?.projectRootPath && existsSync(workspace.projectRootPath)) return workspace.projectRootPath

    const fallback = this.deps.resolveCwd(workspace, session.id, session.agentCwdMode, session.activeWorktree)
    return fallback && existsSync(fallback) ? fallback : null
  }

  private async resolveScope(
    sessionId: string,
    options: { force?: boolean } = {},
  ): Promise<ScopeResolution> {
    const session = this.deps.getSession(sessionId)
    if (!session) return { cwd: null, scope: null }

    const cwd = this.resolveSessionCwd(session)
    const cached = this.scopeCache.get(sessionId)
    if (!options.force && cached && cached.cwd === cwd && this.now() - cached.at < this.scopeTtlMs) {
      return { cwd: cached.cwd, scope: cached.scope, ...(cached.unavailable ? { unavailable: cached.unavailable } : {}) }
    }

    if (!options.force) {
      const pending = this.scopeInFlight.get(sessionId)
      if (pending) return pending
    }

    const promise = this.discoverScope(sessionId, cwd)
    this.scopeInFlight.set(sessionId, promise)
    try {
      const resolution = await promise
      this.scopeCache.set(sessionId, { ...resolution, at: this.now() })
      return resolution
    } finally {
      if (this.scopeInFlight.get(sessionId) === promise) this.scopeInFlight.delete(sessionId)
    }
  }

  private async discoverScope(sessionId: string, cwd: string | null): Promise<ScopeResolution> {
    if (!cwd) {
      return {
        cwd,
        scope: null,
        unavailable: { reason: 'not-git-repository', message: '当前会话没有可用的项目目录，无法关联变更请求。' },
      }
    }

    try {
      const repository = await this.github.discoverRepository(cwd)
      const [branch, upstream, availability] = await Promise.all([
        this.github.currentBranch(cwd).catch(() => null),
        this.github.upstreamRepositoryOf(cwd, repository),
        this.checkGhAvailability(),
      ])
      const scope: ChangeRequestScope = {
        cwd,
        repository,
        ...(branch ? { branch } : {}),
        ...(upstream ? { upstream } : {}),
      }
      return { cwd, scope, ...(availability ? { unavailable: availability } : {}) }
    } catch (error) {
      this.log(`解析会话仓库失败: ${sessionId}`, error)
      return { cwd, scope: null, unavailable: unavailableFrom(error) }
    }
  }

  /** 缓存 gh 可用性结论；缺 gh 不应等第一次轮询失败才被发现。 */
  private async checkGhAvailability(): Promise<ChangeRequestUnavailable | null> {
    const cached = this.availabilityCache
    if (cached && this.now() - cached.at < this.scopeTtlMs) return cached.value
    let value: ChangeRequestUnavailable | null
    try {
      value = await this.github.checkAvailability()
    } catch (error) {
      value = unavailableFrom(error)
    }
    this.availabilityCache = { at: this.now(), value }
    return value
  }

  /** 当前仓库与 upstream 的仓库键集合；所有归属过滤都走这里。 */
  private repositoryKeysOf(scope: ChangeRequestScope): Set<string> {
    const keys = new Set<string>([changeRequestRepositoryKey(scope.repository)])
    if (scope.upstream) keys.add(changeRequestRepositoryKey(scope.upstream))
    return keys
  }

  /** 仅当绑定所属仓库等于当前仓库（或 upstream）时接受。 */
  private scopeAccept(scope: ChangeRequestScope | null, allowUnknown: boolean): (url: string) => boolean {
    if (!scope) return allowUnknown ? () => true : () => false
    const keys = this.repositoryKeysOf(scope)
    return (url: string) => {
      const ref = parseChangeRequestUrl(url)
      if (!ref) return false
      return keys.has(changeRequestRepositoryKey({ host: ref.host, owner: ref.owner, name: ref.repo }))
    }
  }

  private buildState(sessionId: string, resolution: ScopeResolution): ChangeRequestSessionState {
    const scope = resolution.scope
    const all = this.store.list(sessionId).filter((binding) => binding.dismissed !== true)
    const visible = scope ? this.filterByScope(all, scope) : all
    const summaries = visible.map((binding) => toChangeRequestSummary(binding, scope?.branch))
    const refreshedAt = visible.reduce<number | undefined>((latest, binding) => {
      if (binding.fetchedAt === undefined) return latest
      return latest === undefined ? binding.fetchedAt : Math.max(latest, binding.fetchedAt)
    }, undefined)

    return {
      sessionId,
      bindings: visible,
      summaries,
      ...(scope ? { scope } : {}),
      ...(resolution.unavailable ? { unavailable: resolution.unavailable } : {}),
      ...(refreshedAt !== undefined ? { refreshedAt } : {}),
    }
  }

  private emptyState(sessionId: string): ChangeRequestSessionState {
    return { sessionId, bindings: [], summaries: [] }
  }

  /** 当前仓库之外的绑定不展示（隐藏前保留记录，避免重复发现）。 */
  private filterByScope(bindings: readonly ChangeRequestBinding[], scope: ChangeRequestScope): ChangeRequestBinding[] {
    const keys = this.repositoryKeysOf(scope)
    return bindings.filter((binding) => keys.has(changeRequestBindingRepositoryKey(binding)))
  }

  private resolveTargetUrl(sessionId: string, url: string | undefined): string {
    const explicit = url ? normalizeChangeRequestUrl(url) : null
    if (explicit) return explicit
    const first = this.store.list(sessionId).find((binding) => binding.dismissed !== true)
    if (first) return first.url
    throw new Error('当前会话还没有关联变更请求。')
  }

  private handleSdkMessage(sessionId: string, message: unknown): void {
    const raw = asRecord(message)
    if (!raw || raw.isReplay === true) return
    if (raw.type === 'assistant') {
      this.handleAssistantMessage(sessionId, raw)
      return
    }
    if (raw.type === 'user') this.handleUserMessage(sessionId, raw)
  }

  private handleAssistantMessage(sessionId: string, message: Record<string, unknown>): void {
    const content = asRecord(message.message)?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      const toolUse = asRecord(block)
      if (!toolUse || toolUse.type !== 'tool_use') continue
      const name = typeof toolUse.name === 'string' ? toolUse.name : ''
      if (!isShellToolName(name)) continue
      const command = commandFromToolInput(asRecord(toolUse.input) ?? undefined)
      if (!command) continue
      if (typeof toolUse.id === 'string') this.pendingCommands.remember(toolUse.id, command)

      const referenced = selectedChangeRequestUrls(command)
      if (referenced.length > 0) {
        void this.applyObservedBindings(sessionId, referenced, 'referenced')
      }
    }
  }

  private handleUserMessage(sessionId: string, message: Record<string, unknown>): void {
    const content = asRecord(message.message)?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      const toolResult = asRecord(block)
      if (!toolResult || toolResult.type !== 'tool_result') continue
      const toolUseId = typeof toolResult.tool_use_id === 'string' ? toolResult.tool_use_id : ''
      if (!toolUseId) continue
      const command = this.pendingCommands.take(toolUseId)
      if (!command || toolResult.is_error === true) continue
      const text = textOfToolResult(toolResult.content)

      if (isPullRequestCreateCommand(command)) {
        void this.applyObservedBindings(sessionId, extractChangeRequestUrls(text), 'created', { allowUnknownScope: true })
        continue
      }
      if (isPullRequestReferenceCommand(command)) {
        const own = ownChangeRequestUrlFromOutput(text)
        if (own) void this.applyObservedBindings(sessionId, [own], 'referenced')
        continue
      }
      if (isPushCommand(command)) {
        void this.observePushedBranches(sessionId, text)
      }
    }
  }

  /** 观察到的链接先过仓库归属，再写入绑定并立即读一次状态。 */
  private async applyObservedBindings(
    sessionId: string,
    urls: readonly string[],
    source: ChangeRequestBindingSource,
    options: { allowUnknownScope?: boolean } = {},
  ): Promise<void> {
    if (urls.length === 0) return
    const resolution = await this.resolveScope(sessionId)
    if (!resolution.scope && options.allowUnknownScope !== true) return

    const accept = this.scopeAccept(resolution.scope, options.allowUnknownScope === true)
    try {
      const result = this.store.merge(sessionId, urls, source, accept, this.now())
      if (!result.changed) return
    } catch (error) {
      this.log('写入变更请求绑定失败', error)
      return
    }

    this.syncPoller()
    void this.poller.refreshSession(sessionId).catch((error) => {
      this.log('新绑定刷新失败', error)
    })
    this.notify([sessionId])
  }

  /** 推送后按远端 + 分支发现 PR；仓库身份不明时不做任何猜测。 */
  private async observePushedBranches(sessionId: string, output: string): Promise<void> {
    const pushed = pushedBranchesFromOutput(output)
    if (pushed.length === 0) return

    const resolution = await this.resolveScope(sessionId)
    const scope = resolution.scope
    if (!scope) return

    const allowed = this.repositoryKeysOf(scope)

    for (const pushedRef of pushed) {
      const repository = (pushedRef.remote ? this.github.repositoryFromRemote(pushedRef.remote) : null)
        ?? scope.repository
      const key = repositoryKeyOf(repository)
      if (!key || !allowed.has(key)) continue

      const matches = await this.github.findByHead(scope.cwd, repository, pushedRef.branch).catch(() => [])
      const urls = matches.map((match) => match.url)
      if (urls.length > 0) await this.applyObservedBindings(sessionId, urls, 'discovered')
    }
  }

  private scheduleDiscovery(sessionId: string): void {
    if (this.discoveryDebounceMs <= 0) return
    this.clearDiscoveryTimer(sessionId)
    const timer = setTimeout(() => {
      this.discoveryTimers.delete(sessionId)
      if (this.disposed || !this.deps.getSession(sessionId)) return
      void this.discoverSession(sessionId).catch((error) => {
        this.log('轮次结束后发现变更请求失败', error)
      })
    }, this.discoveryDebounceMs)
    this.discoveryTimers.set(sessionId, timer)
  }

  private clearDiscoveryTimer(sessionId: string): void {
    const timer = this.discoveryTimers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.discoveryTimers.delete(sessionId)
  }

  /** 启动自检：隐藏不属于当前仓库的旧绑定（用户创建的 PR 保留）。 */
  private async sweepForeignBindings(): Promise<void> {
    if (this.disposed) return
    for (const sessionId of this.store.listBoundSessions().slice(0, MAX_LIST_SESSIONS)) {
      if (this.disposed) return
      const bindings = this.store.list(sessionId).filter((binding) => binding.dismissed !== true
        && binding.source !== 'created')
      if (bindings.length === 0) continue

      const resolution = await this.resolveScope(sessionId)
      const scope = resolution.scope
      if (!scope) continue
      const keys = this.repositoryKeysOf(scope)

      const foreign = bindings.filter((binding) => !keys.has(changeRequestBindingRepositoryKey(binding)))
      if (foreign.length === 0) continue
      for (const binding of foreign) {
        this.store.dismiss(sessionId, binding.url, this.now())
      }
      this.notify([sessionId])
    }
    this.syncPoller()
  }

  private async fetchUrl(url: string): Promise<ChangeRequestPollResult> {
    try {
      const view = await this.github.viewUrlFromHome(url)
      return { snapshot: view.snapshot }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private settleUrl(url: string, result: ChangeRequestPollResult): string[] {
    const affected: string[] = []
    for (const sessionId of this.store.listBoundSessions()) {
      const owns = this.store.list(sessionId).some(
        (binding) => binding.dismissed !== true
          && binding.url.toLowerCase() === url.toLowerCase(),
      )
      if (!owns) continue
      try {
        if ('snapshot' in result) {
          this.store.setSnapshot(sessionId, url, result.snapshot, this.now())
        } else {
          this.store.setError(sessionId, url, result.error, this.now())
        }
      } catch (error) {
        this.log('保存变更请求状态失败', error)
      }
      affected.push(sessionId)
    }
    return affected
  }

  private notify(sessionIds: readonly string[]): void {
    const unique = [...new Set(sessionIds)]
    if (unique.length === 0 || !this.deps.onChanged) return
    try {
      this.deps.onChanged(unique)
    } catch (error) {
      this.log('推送变更请求状态失败', error)
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private log(message: string, error?: unknown): void {
    if (this.deps.log) {
      this.deps.log(message, error)
      return
    }
    console.warn(`[变更请求] ${message}:`, error)
  }
}

function firstError(results: readonly ChangeRequestPollResult[]): string | undefined {
  const failure = results.find((result): result is { error: string } => 'error' in result)
  return failure ? `刷新失败：${failure.error}` : undefined
}

/** 生产装配：由 ipc.ts 注入真实会话/工作区/事件推送。 */
export interface CreateChangeRequestServiceOptions {
  getSession: ChangeRequestServiceDeps['getSession']
  getWorkspace: ChangeRequestServiceDeps['getWorkspace']
  resolveCwd: ChangeRequestServiceDeps['resolveCwd']
  onChanged?: (sessionIds: string[]) => void
  store?: ChangeRequestStoreLike
  github: GitHubChangeRequestClientLike
  poller?: ChangeRequestPoller
}

export function createChangeRequestService(options: CreateChangeRequestServiceOptions): ChangeRequestService {
  return new ChangeRequestService({
    store: options.store ?? new ChangeRequestStore(),
    github: options.github,
    getSession: options.getSession,
    getWorkspace: options.getWorkspace,
    resolveCwd: options.resolveCwd,
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    ...(options.poller ? { poller: options.poller } : {}),
  })
}
