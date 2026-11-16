/**
 * GitHub 变更请求读取服务
 *
 * 只通过本机 `git` 与 `gh` 命令读取信息：
 * - 用 `git remote get-url origin` / `git branch --show-current` 解析仓库身份与分支
 * - 用 `gh pr list/view` 读取 PR 编号、标题、状态与检查项
 *
 * 不读取、不保存、不打印任何 token；不自动登录，也不创建或推送 PR。
 * 命令输出与错误都归一成中文说明，便于侧栏直接展示不可用原因。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type {
  ChangeRequestCheck,
  ChangeRequestSnapshot,
  ChangeRequestUnavailable,
  ChangeRequestUnavailableReason,
} from '@proma/shared'
import { normalizeChangeRequestState, normalizeChangeRequestUrl, parseChangeRequestUrl } from '@proma/shared'

const execFileAsync = promisify(execFile)

/** 单条命令超时：gh 网络请求慢时宁可失败也不挂住主进程。 */
const COMMAND_TIMEOUT_MS = 15_000
const COMMAND_MAX_BUFFER = 1024 * 1024

const VIEW_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup'
const LIST_FIELDS = 'number,url,headRefName,headRepositoryOwner'

/** 仓库身份；host 允许 GitHub Enterprise 域名。 */
export interface GitHubRepository {
  host: string
  owner: string
  name: string
}

/** 执行命令的注入点；测试用假 runner 替换，不访问网络。 */
export type GitHubCommandRunner = (program: string, args: readonly string[], cwd: string) => Promise<string>

/** 按分支发现的一条 PR。 */
export interface GitHubChangeRequestMatch {
  repository: GitHubRepository
  number: number
  url: string
}

/** PR 读取结果。 */
export interface GitHubChangeRequestView {
  url: string
  snapshot: ChangeRequestSnapshot
}

/**
 * 变更请求读取失败。
 *
 * reason 与共享的不可用分类一致，UI 不必再解析错误文案。
 */
export class GitHubChangeRequestError extends Error {
  readonly reason: ChangeRequestUnavailableReason

  constructor(message: string, reason: ChangeRequestUnavailableReason) {
    super(message)
    this.name = 'GitHubChangeRequestError'
    this.reason = reason
  }
}

function failureReason(program: string): ChangeRequestUnavailableReason {
  return program === 'git' ? 'git-missing' : 'gh-missing'
}

function missingMessage(program: string): string {
  return `找不到 ${program}，请安装并确保它在 PATH 中。`
}

function looksLikeAuthFailure(stderr: string): boolean {
  const value = stderr.toLowerCase()
  return value.includes('gh auth login')
    || value.includes('not logged in')
    || value.includes('authentication')
    || value.includes('http 401')
    || value.includes('requires authentication')
    || value.includes('no oauth token')
}

interface CommandFailure {
  code?: string
  killed?: boolean
  stderr?: string
}

/** 默认 runner：隐藏 Windows 控制台、禁用交互提示、超时即失败。 */
const defaultRunner: GitHubCommandRunner = async (program, args, cwd) => {
  try {
    const result = await execFileAsync(program, [...args], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: '',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    return String(result.stdout)
  } catch (error) {
    const failure = (error ?? {}) as CommandFailure
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    if (failure.code === 'ENOENT') {
      throw new GitHubChangeRequestError(missingMessage(program), failureReason(program))
    }
    if (failure.killed) {
      throw new GitHubChangeRequestError(`${program} 请求超时，请检查网络后重试。`, 'failed')
    }
    if (looksLikeAuthFailure(stderr)) {
      throw new GitHubChangeRequestError(
        'gh 尚未登录 GitHub，请先在该机器上运行 gh auth login。',
        'gh-auth',
      )
    }
    throw new GitHubChangeRequestError(
      stderr || `${program} 执行失败，请检查仓库、登录状态和网络。`,
      'failed',
    )
  }
}

function isRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

function buildRepository(host: string, owner: string, name: string): GitHubRepository | null {
  const normalizedHost = host.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalizedHost)) return null
  if (!isRepositorySegment(owner) || !isRepositorySegment(name)) return null
  return { host: normalizedHost, owner, name }
}

/** 解析 git remote 的 URL（https / ssh / scp 形式）。 */
export function parseGitHubRemote(remote: string): GitHubRepository | null {
  const value = remote.trim()
  if (!value) return null

  const scp = /^git@([a-zA-Z0-9.-]+):([^?#]+)$/.exec(value)
  if (scp) {
    const [, host, path] = scp
    return host && path ? repositoryFromPath(host, path) : null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null
  if (url.password || url.port || url.search || url.hash) return null
  if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
  return repositoryFromPath(url.hostname, url.pathname.replace(/^\//, ''))
}

function repositoryFromPath(host: string, path: string): GitHubRepository | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(path)
  if (!match?.[1] || !match[2]) return null
  return buildRepository(host, match[1], match[2])
}

/** 解析推送输出里的远端（`git@host:owner/repo` 或 `host:owner/repo`）。 */
export function parseRemoteTarget(target: string): GitHubRepository | null {
  const direct = parseGitHubRemote(target)
  if (direct) return direct
  const scpLike = /^([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}):(\/?[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(target.trim())
  return scpLike?.[1] && scpLike[2] ? parseGitHubRemote(`git@${scpLike[1]}:${scpLike[2]}`) : null
}

/** owner/name；用于 gh 的 --repo 参数。 */
export function repositorySlug(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`
}

function parseRepositorySlug(slug: string, host: string): GitHubRepository | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(slug.trim())
  return match?.[1] && match[2] ? buildRepository(host, match[1], match[2]) : null
}

function mapChecks(rollup: unknown): ChangeRequestCheck[] {
  if (!Array.isArray(rollup)) return []
  return rollup.map((item) => {
    const check = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      name: typeof check.name === 'string' ? check.name : typeof check.context === 'string' ? check.context : '检查',
      status: typeof check.status === 'string' ? check.status : typeof check.state === 'string' ? check.state : '',
      conclusion: typeof check.conclusion === 'string' ? check.conclusion : '',
    }
  })
}

function parseJsonObject(output: string, message: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new GitHubChangeRequestError(message, 'failed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GitHubChangeRequestError(message, 'failed')
  }
  return parsed as Record<string, unknown>
}

function parseJsonArray(output: string, message: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new GitHubChangeRequestError(message, 'failed')
  }
  if (!Array.isArray(parsed)) throw new GitHubChangeRequestError(message, 'failed')
  return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

/**
 * 读取 GitHub 变更请求。
 *
 * 所有命令都限定在会话 cwd 内执行；URL 读取用 homedir，避免 worktree 已删除时失败。
 */
export class GitHubChangeRequestService {
  private readonly run: GitHubCommandRunner

  constructor(run: GitHubCommandRunner = defaultRunner) {
    this.run = run
  }

  /** 解析 origin 远端；不是受支持的 GitHub 远端时给出可读原因。 */
  async discoverRepository(cwd: string): Promise<GitHubRepository> {
    let remote: string
    try {
      remote = await this.run('git', ['remote', 'get-url', 'origin'], cwd)
    } catch (error) {
      if (error instanceof GitHubChangeRequestError) {
        if (error.reason === 'failed' && /not a git repository/i.test(error.message)) {
          throw new GitHubChangeRequestError('当前会话目录不是 Git 仓库，无法关联变更请求。', 'not-git-repository')
        }
        if (error.reason === 'failed' && /no such remote|does not appear to be a git repository/i.test(error.message)) {
          throw new GitHubChangeRequestError('当前仓库没有 origin 远端，无法关联变更请求。', 'no-github-remote')
        }
        throw error
      }
      throw new GitHubChangeRequestError('无法读取仓库远端。', 'failed')
    }

    const repository = parseGitHubRemote(remote)
    if (!repository) {
      throw new GitHubChangeRequestError('origin 不是受支持的 GitHub 远端，请检查仓库远端配置。', 'no-github-remote')
    }
    return repository
  }

  /** 当前分支；detached HEAD 返回 null（不做分支发现）。 */
  async currentBranch(cwd: string): Promise<string | null> {
    const branch = (await this.run('git', ['branch', '--show-current'], cwd)).trim()
    return branch || null
  }

  /** 仓库根目录；无法读取时 null。 */
  async repositoryRoot(cwd: string): Promise<string | null> {
    try {
      const root = (await this.run('git', ['rev-parse', '--show-toplevel'], cwd)).trim()
      return root || null
    } catch {
      return null
    }
  }

  /** 远端目标（URL 或 `host:owner/repo`）→ 仓库；无法解析时 null。 */
  repositoryFromRemote(target: string): GitHubRepository | null {
    return parseRemoteTarget(target)
  }

  /** origin 是 fork 时返回 upstream 仓库，否则 null。 */
  async upstreamRepositoryOf(cwd: string, repository: GitHubRepository): Promise<GitHubRepository | null> {
    try {
      const output = await this.run('gh', ['repo', 'view', repositorySlug(repository), '--json', 'parent'], cwd)
      const parsed = parseJsonObject(output, 'GitHub 返回了无效的仓库信息。')
      const parent = parsed.parent
      if (!parent || typeof parent !== 'object') return null
      const slug = (parent as Record<string, unknown>).nameWithOwner
      return typeof slug === 'string' ? parseRepositorySlug(slug, repository.host) : null
    } catch {
      return null
    }
  }

  /**
   * 按分支列出 open PR：先查 origin，fork 时再查 upstream，按 PR 链接去重。
   *
   * 结果必须同时满足分支名、owner 与仓库身份三件事，避免不同仓库的同名分支串台。
   */
  async findByHead(
    cwd: string,
    repository: GitHubRepository,
    branch: string,
  ): Promise<GitHubChangeRequestMatch[]> {
    if (!branch.trim()) {
      throw new GitHubChangeRequestError('当前处于 detached HEAD，无法自动发现变更请求。', 'failed')
    }

    const upstream = await this.upstreamRepositoryOf(cwd, repository)
    const targets = upstream ? [repository, upstream] : [repository]
    const allowedOwners = new Set(
      [repository.owner, upstream?.owner]
        .filter((owner): owner is string => typeof owner === 'string')
        .map((owner) => owner.toLowerCase()),
    )

    const matches: GitHubChangeRequestMatch[] = []
    const seen = new Set<string>()
    for (const target of targets) {
      const output = await this.run(
        'gh',
        ['pr', 'list', '--repo', `${target.host}/${repositorySlug(target)}`, '--state', 'open', '--head', branch, '--limit', '100', '--json', LIST_FIELDS],
        cwd,
      )
      const items = parseJsonArray(output, 'GitHub 返回了无效的变更请求列表。')
      for (const item of items) {
        if (item.headRefName !== branch) continue
        const headOwner = item.headRepositoryOwner
        const ownerLogin = headOwner && typeof headOwner === 'object'
          ? (headOwner as Record<string, unknown>).login
          : undefined
        if (typeof ownerLogin === 'string' && !allowedOwners.has(ownerLogin.toLowerCase())) continue
        if (typeof item.number !== 'number' || !Number.isSafeInteger(item.number) || item.number <= 0) continue
        if (typeof item.url !== 'string') continue

        const url = normalizeChangeRequestUrl(item.url)
        const ref = url ? parseChangeRequestUrl(url) : null
        if (!url || !ref) continue
        if (ref.number !== item.number) continue
        if (ref.host !== target.host || ref.owner.toLowerCase() !== target.owner.toLowerCase() || ref.repo.toLowerCase() !== target.name.toLowerCase()) continue
        if (seen.has(url.toLowerCase())) continue

        seen.add(url.toLowerCase())
        matches.push({ repository: target, number: item.number, url })
      }
    }
    return matches
  }

  /** 读取单条 PR 的最新状态；编号或链接与入参不一致时拒绝。 */
  async viewUrl(url: string, cwd: string = homedir()): Promise<GitHubChangeRequestView> {
    const normalized = normalizeChangeRequestUrl(url)
    const ref = normalized ? parseChangeRequestUrl(normalized) : null
    if (!normalized || !ref) {
      throw new GitHubChangeRequestError('请输入当前 GitHub host 的变更请求链接。', 'failed')
    }

    const output = await this.run('gh', ['pr', 'view', normalized, '--json', VIEW_FIELDS], cwd)
    const parsed = parseJsonObject(output, 'GitHub 返回了无效的变更请求。')
    if (parsed.number !== ref.number || typeof parsed.url !== 'string' || !sameUrl(parsed.url, normalized)) {
      throw new GitHubChangeRequestError('GitHub 返回了不匹配的变更请求。', 'failed')
    }

    return {
      url: normalized,
      snapshot: {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        state: normalizeChangeRequestState(parsed.state),
        isDraft: parsed.isDraft === true,
        headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
        baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '',
        reviewDecision: typeof parsed.reviewDecision === 'string' ? parsed.reviewDecision : '',
        mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable.toUpperCase() : 'UNKNOWN',
        checks: mapChecks(parsed.statusCheckRollup),
        fetchedAt: Date.now(),
      },
    }
  }

  /** URL 读取不依赖会话 cwd：worktree 被删除后仍能刷新状态。 */
  async viewUrlFromHome(url: string): Promise<GitHubChangeRequestView> {
    return this.viewUrl(url, homedir())
  }

  /**
   * 检查 `gh` 是否可执行。
   *
   * 只跑 `gh --version`（本地、不联网、不需要登录），用于在没有任何读取尝试前
   * 就告诉用户"缺少 gh"。登录状态由实际读取的错误文案说明，避免额外联网探测。
   */
  async checkAvailability(): Promise<ChangeRequestUnavailable | null> {
    try {
      await this.run('gh', ['--version'], homedir())
      return null
    } catch (error) {
      if (error instanceof GitHubChangeRequestError) {
        const reason: ChangeRequestUnavailableReason = error.reason === 'gh-missing' ? 'gh-missing' : 'failed'
        return { reason, message: error.message }
      }
      return { reason: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
}

function sameUrl(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}
