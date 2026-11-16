/**
 * 会话变更请求（GitHub PR）共享契约
 *
 * 只描述本地 `git`/`gh` 能读到的内容：仓库身份、分支、PR 编号与状态。
 * 不包含任何 Proma Cloud 字段、账户信息或访问凭据。
 */

/** GitHub 变更请求状态；未知状态按 OPEN 处理，避免把已关闭的 PR 伪装成打开。 */
export type ChangeRequestState = 'OPEN' | 'MERGED' | 'CLOSED'

/**
 * 绑定来源：
 * - discovered：按当前分支在远端发现的 open PR
 * - referenced：Agent 在工具输出里引用的 PR（gh pr view/edit/checkout）
 * - created：Agent 执行 `gh pr create` 后输出的 PR
 */
export type ChangeRequestBindingSource = 'discovered' | 'referenced' | 'created'

/** 从 PR 链接解析出的稳定引用。 */
export interface ChangeRequestRef {
  host: string
  owner: string
  repo: string
  number: number
}

/** 单个检查项；不保存任何日志正文。 */
export interface ChangeRequestCheck {
  name: string
  status: string
  conclusion: string
}

/** 最近一次成功读取到的 PR 状态快照。 */
export interface ChangeRequestSnapshot {
  title: string
  state: ChangeRequestState
  isDraft: boolean
  /** head（来源）分支名 */
  headRefName: string
  /** base（目标）分支名 */
  baseRefName: string
  /** GitHub reviewDecision 原值，例如 APPROVED */
  reviewDecision: string
  /** GitHub mergeable 原值，例如 MERGEABLE / CONFLICTING / UNKNOWN */
  mergeable: string
  checks: ChangeRequestCheck[]
  fetchedAt: number
}

/** 会话与一条 PR 的绑定记录；`url` 是唯一键（已规范化）。 */
export interface ChangeRequestBinding {
  url: string
  host: string
  owner: string
  repo: string
  number: number
  source: ChangeRequestBindingSource
  createdAt: number
  /** 用户隐藏后仍保留绑定，避免再次被自动发现；不影响轮询。 */
  dismissed?: boolean
  snapshot?: ChangeRequestSnapshot
  /** 最近一次读取时间（成功或失败）。 */
  fetchedAt?: number
  /** 最近一次读取失败原因；成功后清空。 */
  error?: string
}

/** 仓库身份：host + owner/name，用于跨仓库隔离。 */
export interface ChangeRequestRepositoryIdentity {
  host: string
  owner: string
  name: string
}

/** 会话解析出的仓库作用域；同一分支名在别的仓库里不算同一条 PR。 */
export interface ChangeRequestScope {
  /** 解析作用域使用的本地目录（worktree 或项目根）。 */
  cwd: string
  repository: ChangeRequestRepositoryIdentity
  /** 当前分支；detached HEAD 缺失。 */
  branch?: string
  /** fork 场景下的 upstream 仓库，发现 PR 时一并查询。 */
  upstream?: ChangeRequestRepositoryIdentity
}

/** 变更请求能力不可用的原因分类，供侧栏提示与降级文案使用。 */
export type ChangeRequestUnavailableReason =
  | 'git-missing'
  | 'gh-missing'
  | 'gh-auth'
  | 'not-git-repository'
  | 'no-github-remote'
  | 'failed'

/** 不可用原因与其用户可见说明。 */
export interface ChangeRequestUnavailable {
  reason: ChangeRequestUnavailableReason
  message: string
}

/** 侧栏与徽标展示所需的扁平摘要。 */
export interface ChangeRequestSummary {
  url: string
  number: number
  host: string
  /** owner/repo */
  repository: string
  title: string
  state: ChangeRequestState
  isDraft: boolean
  /** 优先取快照 head 分支，缺失时回退到会话分支。 */
  branch?: string
  checksPending: boolean
  error?: string
}

/** 单个会话的变更请求状态；侧栏按 sessionId 索引。 */
export interface ChangeRequestSessionState {
  sessionId: string
  scope?: ChangeRequestScope
  bindings: ChangeRequestBinding[]
  /** 与 bindings 一一对应，由主进程预计算，避免渲染层重复解析。 */
  summaries: ChangeRequestSummary[]
  unavailable?: ChangeRequestUnavailable
  refreshedAt?: number
}

/** 会话级操作；open 返回链接，由主进程调用系统浏览器。 */
export type ChangeRequestActionKind = 'open' | 'refresh' | 'dismiss'

export interface ChangeRequestActionInput {
  sessionId: string
  action: ChangeRequestActionKind
  /** open/dismiss 必填，refresh 可选（只刷新单条）。 */
  url?: string
}

export interface ChangeRequestActionResult {
  session: ChangeRequestSessionState
  /** action=open 时给出应打开的链接。 */
  openedUrl?: string
  /** 操作失败但会话状态仍可返回时的说明。 */
  error?: string
}

export interface ChangeRequestListInput {
  /** 只查询这些会话；省略时返回所有存在绑定的会话。 */
  sessionIds?: string[]
}

export interface ChangeRequestListResult {
  sessions: ChangeRequestSessionState[]
}

/** 主进程推送：这些会话的变更请求状态已变化。 */
export interface ChangeRequestsChangedPayload {
  sessionIds: string[]
}

/** 变更请求 IPC 通道；与 Agent 通道分开，避免改动既有通道常量。 */
export const CHANGE_REQUEST_IPC_CHANNELS = {
  /** 读取会话状态（有绑定或作用域变化的会话） */
  LIST: 'change-request:list',
  /** 立即刷新单个会话，返回最新状态 */
  REFRESH: 'change-request:refresh',
  /** 会话级操作：open / refresh / dismiss */
  ACTION: 'change-request:action',
  /** 主进程 → 渲染进程：状态变化通知 */
  CHANGED: 'change-request:changed',
} as const

const URL_SEGMENT = /^[A-Za-z0-9_.-]+$/
const URL_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
const MAX_URL_LENGTH = 2000

function isSafeSegment(value: string): boolean {
  return URL_SEGMENT.test(value) && value !== '.' && value !== '..'
}

/** 严格解析 `https://host/owner/repo/pull/<number>`；任何多余成分都拒绝。 */
export function parseChangeRequestUrl(input: string): ChangeRequestRef | null {
  const value = input.trim()
  if (!value || value.length > MAX_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port) return null

  const host = url.hostname.toLowerCase()
  if (!URL_HOST.test(host)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 4 || parts[2] !== 'pull') return null
  const [owner, repo, , digits] = parts
  if (!owner || !repo || !digits || !isSafeSegment(owner) || !isSafeSegment(repo)) return null
  if (!/^[1-9]\d*$/.test(digits)) return null

  const number = Number(digits)
  if (!Number.isSafeInteger(number)) return null
  return { host, owner, repo, number }
}

/** 规范化为 `https://host/owner/repo/pull/number`；无法解析时 null。 */
export function normalizeChangeRequestUrl(input: string): string | null {
  const ref = parseChangeRequestUrl(input)
  return ref ? changeRequestUrlOf(ref) : null
}

/** 已知引用拼回规范链接。 */
export function changeRequestUrlOf(ref: ChangeRequestRef): string {
  return `https://${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}/pull/${ref.number}`
}

/** 比较两个 PR 链接是否指向同一条记录（大小写与尾部差异被规范化）。 */
export function sameChangeRequestUrl(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** 未知状态按 OPEN 处理，避免把未知数据展示成已关闭。 */
export function normalizeChangeRequestState(state: unknown): ChangeRequestState {
  const value = typeof state === 'string' ? state.toUpperCase() : ''
  return value === 'MERGED' || value === 'CLOSED' ? value : 'OPEN'
}

/** GitHub 检查项是否仍在进行中（决定轮询是否需要加速）。 */
export function isChangeRequestCheckPending(check: ChangeRequestCheck): boolean {
  const status = (check.status || '').toUpperCase()
  return status === 'PENDING' || status === 'QUEUED' || status === 'IN_PROGRESS' || status === 'WAITING'
}

/** 仓库键：host/owner/name 小写，用于跨仓库隔离与去重。 */
export function changeRequestRepositoryKey(repository: ChangeRequestRepositoryIdentity): string {
  return `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase()
}

/** 绑定所属仓库键；与作用域键同构，可直接比较。 */
export function changeRequestBindingRepositoryKey(
  binding: Pick<ChangeRequestBinding, 'host' | 'owner' | 'repo'>,
): string {
  return `${binding.host}/${binding.owner}/${binding.repo}`.toLowerCase()
}

/** 把绑定折叠成展示摘要；缺失快照时用会话分支兜底。 */
export function toChangeRequestSummary(
  binding: ChangeRequestBinding,
  fallbackBranch?: string,
): ChangeRequestSummary {
  const snapshot = binding.snapshot
  const branch = snapshot?.headRefName || fallbackBranch
  return {
    url: binding.url,
    number: binding.number,
    host: binding.host,
    repository: `${binding.owner}/${binding.repo}`,
    title: snapshot?.title ?? '',
    state: snapshot?.state ?? 'OPEN',
    isDraft: snapshot?.isDraft === true,
    ...(branch ? { branch } : {}),
    checksPending: (snapshot?.checks ?? []).some(isChangeRequestCheckPending),
    ...(binding.error ? { error: binding.error } : {}),
  }
}
