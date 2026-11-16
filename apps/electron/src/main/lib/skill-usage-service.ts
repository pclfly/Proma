/**
 * Skill 真实使用统计服务
 *
 * 按工作区聚合会话中真实发生的 Skill 激活记录，供「最近使用 / 使用频度 /
 * 30 天未用」视图使用。统计只认结构化激活证据，不把正文提及或其它工作区的
 * 同名 Skill 计入。
 *
 * 设计约束：
 * - 每个工作区最多扫描最近活动的 400 个会话，读取并发上限 4；
 * - 结果缓存在 `skill-usage-cache.json`（原子写），缓存按版本号失效；
 * - 缓存清理只移除已不存在的会话，仍存在但落在 400 窗口外的条目保留；
 * - 统计逻辑本身不直接读取用户目录；只有默认依赖实现才落到配置目录。
 */

import { join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
import { getConfigDir, resolveAgentWorkspaceDirPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { parseSkillActivations } from './skill-usage-parse'
import type { SkillActivationRecord } from './skill-usage-parse'

/** 落盘缓存格式版本；结构变化时递增，旧缓存直接失效。 */
export const SKILL_USAGE_CACHE_VERSION = 1

/** 每个工作区最多扫描的会话数。 */
export const SKILL_USAGE_MAX_SESSIONS = 400

/** 会话消息并发读取上限。 */
export const SKILL_USAGE_READ_CONCURRENCY = 4

/** 「闲置」默认窗口天数。 */
export const SKILL_USAGE_STALE_DAYS = 30

const DAY_MS = 86_400_000
const CACHE_FILE_NAME = 'skill-usage-cache.json'

/** 统计目标工作区；只需要身份字段，`AgentWorkspace` 可直接传入。 */
export interface SkillUsageWorkspace {
  id: string
  slug: string
}

/** 单个 Skill 路径的真实使用统计。 */
export interface SkillUsageStat {
  /** 最近一次真实激活时间；0 表示有记录但无法确定时间。 */
  lastUsedAt: number
  /** 激活次数（按 user 消息/回退会话计；同一消息内同 Skill 去重）。 */
  useCount: number
  /** 使用过该 Skill 的会话数。 */
  sessionsUsed: number
}

/** 统计覆盖范围，用于向用户说明统计口径，避免把未知伪装成「从未使用」。 */
export interface SkillUsageCoverage {
  /** 本次统计纳入的会话数（最多 400）。 */
  scannedSessions: number
  /** 该工作区全部会话数（不受 400 上限影响）。 */
  totalWorkspaceSessions: number
  /** 是否因 400 上限只统计了最近活动的部分会话。 */
  truncated: boolean
  /** 纳入统计的会话中最早的活动时间；0 表示没有任何会话。 */
  earliestActivityAt: number
  /** 纳入统计的激活记录中最早的使用时间；0 表示没有可确定时间的激活。 */
  earliestUsedAt: number
  /** 读取失败的会话数；失败会话不计入使用记录。 */
  unreadableSessions: number
  /** 本次统计时间。 */
  computedAt: number
}

/** 统计结果：Skill 路径 → 使用统计。 */
export interface SkillUsageCollection {
  workspaceSlug: string
  /** key 为规范化 Skill 路径：工作区 Skill 使用 `<slug>/SKILL.md`。 */
  usage: Record<string, SkillUsageStat>
  coverage: SkillUsageCoverage
}

/** 供上层直接消费的 summary；`fromCache` 表示本次没有重新读取任何会话。 */
export interface SkillUsageSummary extends SkillUsageCollection {
  fromCache: boolean
  updatedAt: number
}

/** 单个会话的缓存记录。 */
export interface SkillUsageSessionCache {
  /** 会话最近活动时间；用于判断是否需要重新解析。 */
  activityAt: number
  activations: SkillActivationRecord[]
}

/** 单个工作区的缓存记录。 */
export interface SkillUsageWorkspaceCache {
  updatedAt: number
  /** key 为会话 ID；只保留仍存在的会话。 */
  sessions: Record<string, SkillUsageSessionCache>
}

/** `skill-usage-cache.json` 的落盘结构。 */
export interface SkillUsageCacheFile {
  version: number
  workspaces: Record<string, SkillUsageWorkspaceCache>
}

/** 可注入依赖；默认实现使用现有主进程模块。 */
export interface SkillUsageServiceDeps {
  listSessions?: () => readonly AgentSessionMeta[] | Promise<readonly AgentSessionMeta[]>
  readSessionMessages?: (sessionId: string) => readonly unknown[] | Promise<readonly unknown[]>
  now?: () => number
  readCache?: () => SkillUsageCacheFile | null
  writeCache?: (cache: SkillUsageCacheFile) => void
  /** 工作区 skills 目录绝对路径；默认从配置目录推导，且不创建目录。 */
  workspaceSkillsRoot?: (workspace: SkillUsageWorkspace) => string | undefined
}

interface ResolvedSkillUsageDeps {
  listSessions: () => readonly AgentSessionMeta[] | Promise<readonly AgentSessionMeta[]>
  readSessionMessages: (sessionId: string) => readonly unknown[] | Promise<readonly unknown[]>
  now: () => number
  readCache: () => SkillUsageCacheFile | null
  writeCache: (cache: SkillUsageCacheFile) => void
  workspaceSkillsRoot: (workspace: SkillUsageWorkspace) => string | undefined
}

interface SessionSelection {
  /** 该工作区全部会话，按最近活动降序。 */
  all: AgentSessionMeta[]
  /** 实际纳入统计的会话（最多 400）。 */
  selected: AgentSessionMeta[]
  truncated: boolean
}

interface ScanOutcome {
  entries: Map<string, SkillUsageSessionCache>
  unreadable: Set<string>
}

/** 单进程内的 summary 缓存；key 为工作区 slug。 */
const memorySummaryCache = new Map<string, { signature: string; summary: SkillUsageSummary }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话真实活动时间：与侧栏排序口径一致。 */
function getSessionActivityTime(session: Pick<AgentSessionMeta, 'lastActivityAt' | 'updatedAt'>): number {
  return session.lastActivityAt ?? session.updatedAt
}

function selectWorkspaceSessions(
  workspace: SkillUsageWorkspace,
  sessions: readonly AgentSessionMeta[],
): SessionSelection {
  const all = sessions
    .filter((session) => session.workspaceId === workspace.id)
    .sort((a, b) => getSessionActivityTime(b) - getSessionActivityTime(a))
  // 草稿还没发送首条消息，不可能有 Skill 激活；保留在 all 里只为不误删其缓存条目。
  const candidates = all.filter((session) => !session.isDraft)
  const selected = candidates.slice(0, SKILL_USAGE_MAX_SESSIONS)
  return { all, selected, truncated: candidates.length > selected.length }
}

/** 有界并发映射；结果顺序与输入一致。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await mapper(items[currentIndex] as T)
    }
  }))

  return results
}

function buildScanSignature(
  workspace: SkillUsageWorkspace,
  sessions: readonly AgentSessionMeta[],
  skillsRoot: string | undefined,
): string {
  const sessionPart = sessions
    .map((session) => `${session.id}@${getSessionActivityTime(session)}`)
    .join('|')
  return `${workspace.id}\n${workspace.slug}\n${skillsRoot ?? ''}\n${sessionPart}`
}

async function scanSessions(
  workspace: SkillUsageWorkspace,
  targets: readonly AgentSessionMeta[],
  deps: ResolvedSkillUsageDeps,
): Promise<ScanOutcome> {
  const skillsRoot = deps.workspaceSkillsRoot(workspace)
  const entries = new Map<string, SkillUsageSessionCache>()
  const unreadable = new Set<string>()

  const outcomes = await mapWithConcurrency(
    targets,
    SKILL_USAGE_READ_CONCURRENCY,
    async (session) => {
      const activityAt = getSessionActivityTime(session)
      try {
        const messages = await deps.readSessionMessages(session.id)
        const activations = parseSkillActivations(messages, {
          workspaceSlug: workspace.slug,
          ...(skillsRoot ? { workspaceSkillsRoot: skillsRoot } : {}),
          sessionActivityAt: activityAt,
        })
        return { sessionId: session.id, entry: { activityAt, activations }, readable: true }
      } catch (error) {
        console.warn(`[Skill 使用统计] 读取会话失败，跳过: ${session.id}`, error)
        return { sessionId: session.id, entry: { activityAt, activations: [] }, readable: false }
      }
    },
  )

  for (const outcome of outcomes) {
    // 读取失败不写入缓存，避免把一次瞬时失败固化成「该会话没有使用记录」。
    if (outcome.readable) entries.set(outcome.sessionId, outcome.entry)
    else unreadable.add(outcome.sessionId)
  }

  return { entries, unreadable }
}

/** Skill 路径 → 使用统计；使用 Map 聚合，避免 `__proto__` 之类的路径键污染原型。 */
function aggregateUsage(
  sessions: readonly SkillUsageSessionCache[],
): Record<string, SkillUsageStat> {
  const usage = new Map<string, SkillUsageStat>()

  for (const session of sessions) {
    const seenInSession = new Set<string>()
    for (const activation of session.activations) {
      const current = usage.get(activation.skillPath) ?? {
        lastUsedAt: 0,
        useCount: 0,
        sessionsUsed: 0,
      }
      current.useCount += 1
      if (activation.activatedAt > current.lastUsedAt) current.lastUsedAt = activation.activatedAt
      if (!seenInSession.has(activation.skillPath)) {
        current.sessionsUsed += 1
        seenInSession.add(activation.skillPath)
      }
      usage.set(activation.skillPath, current)
    }
  }

  return Object.fromEntries(usage)
}

function buildCoverage(
  selection: SessionSelection,
  sessions: readonly SkillUsageSessionCache[],
  unreadableSessions: number,
  now: number,
): SkillUsageCoverage {
  let earliestActivityAt = 0
  for (const session of selection.selected) {
    const activityAt = getSessionActivityTime(session)
    if (activityAt > 0 && (earliestActivityAt === 0 || activityAt < earliestActivityAt)) {
      earliestActivityAt = activityAt
    }
  }

  let earliestUsedAt = 0
  for (const session of sessions) {
    for (const activation of session.activations) {
      if (activation.activatedAt > 0 && (earliestUsedAt === 0 || activation.activatedAt < earliestUsedAt)) {
        earliestUsedAt = activation.activatedAt
      }
    }
  }

  return {
    scannedSessions: selection.selected.length,
    totalWorkspaceSessions: selection.all.length,
    truncated: selection.truncated,
    earliestActivityAt,
    earliestUsedAt,
    unreadableSessions,
    computedAt: now,
  }
}

function isActivationRecord(value: unknown): value is SkillActivationRecord {
  return isRecord(value)
    && typeof value.skillPath === 'string'
    && value.skillPath.trim() !== ''
    && typeof value.skillName === 'string'
    && typeof value.activatedAt === 'number'
    && Number.isFinite(value.activatedAt)
}

/** 校验并清洗落盘缓存；版本不匹配时视为空缓存。 */
function normalizeCacheFile(raw: unknown): SkillUsageCacheFile {
  const empty: SkillUsageCacheFile = { version: SKILL_USAGE_CACHE_VERSION, workspaces: {} }
  if (!isRecord(raw) || raw.version !== SKILL_USAGE_CACHE_VERSION || !isRecord(raw.workspaces)) {
    return empty
  }

  const workspaces: Array<[string, SkillUsageWorkspaceCache]> = []
  for (const [slug, workspaceValue] of Object.entries(raw.workspaces)) {
    if (!isRecord(workspaceValue) || !isRecord(workspaceValue.sessions)) continue

    const sessions: Array<[string, SkillUsageSessionCache]> = []
    for (const [sessionId, sessionValue] of Object.entries(workspaceValue.sessions)) {
      if (!isRecord(sessionValue)) continue
      const activityAt = typeof sessionValue.activityAt === 'number' && Number.isFinite(sessionValue.activityAt)
        ? sessionValue.activityAt
        : 0
      const activations = Array.isArray(sessionValue.activations)
        ? sessionValue.activations.filter(isActivationRecord)
        : []
      sessions.push([sessionId, { activityAt, activations }])
    }

    const updatedAt = typeof workspaceValue.updatedAt === 'number' && Number.isFinite(workspaceValue.updatedAt)
      ? workspaceValue.updatedAt
      : 0
    workspaces.push([slug, { updatedAt, sessions: Object.fromEntries(sessions) }])
  }

  return { version: SKILL_USAGE_CACHE_VERSION, workspaces: Object.fromEntries(workspaces) }
}

function getWorkspaceCache(
  cacheFile: SkillUsageCacheFile,
  slug: string,
): SkillUsageWorkspaceCache | undefined {
  return Object.hasOwn(cacheFile.workspaces, slug) ? cacheFile.workspaces[slug] : undefined
}

function getSkillUsageCachePath(): string {
  return join(getConfigDir(), CACHE_FILE_NAME)
}

async function resolveDeps(deps: SkillUsageServiceDeps): Promise<ResolvedSkillUsageDeps> {
  let listSessions = deps.listSessions
  let readSessionMessages = deps.readSessionMessages

  if (!listSessions || !readSessionMessages) {
    // 运行时模块会加载 Electron 依赖，测试注入依赖时不应触发；因此延迟导入。
    const sessionManager = await import('./agent-session-manager')
    listSessions ??= () => sessionManager.listAgentSessions()
    readSessionMessages ??= (sessionId) => sessionManager.getAgentSessionSDKMessagesForUi(sessionId)
  }

  const configuredListSessions = listSessions
  const configuredReadSessionMessages = readSessionMessages

  return {
    listSessions: configuredListSessions,
    readSessionMessages: configuredReadSessionMessages,
    now: deps.now ?? (() => Date.now()),
    readCache: deps.readCache ?? (() => readJsonFileSafe<SkillUsageCacheFile>(getSkillUsageCachePath())),
    writeCache: deps.writeCache ?? ((cache) => {
      writeJsonFileAtomic(getSkillUsageCachePath(), cache)
    }),
    workspaceSkillsRoot: deps.workspaceSkillsRoot
      ?? ((workspace) => join(resolveAgentWorkspaceDirPath(workspace.slug), 'skills')),
  }
}

/**
 * 全量扫描工作区最近会话，返回每个 Skill 路径的真实使用统计。
 *
 * 纯读取，不读写缓存；`getSkillUsageSummary` 在此之上做增量缓存。
 */
export async function collectSkillUsage(
  workspace: SkillUsageWorkspace,
  deps: SkillUsageServiceDeps = {},
): Promise<SkillUsageCollection> {
  const resolved = await resolveDeps(deps)
  const now = resolved.now()
  const sessions = await resolved.listSessions()
  const selection = selectWorkspaceSessions(workspace, sessions)
  const outcome = await scanSessions(workspace, selection.selected, resolved)

  const selectedEntries: SkillUsageSessionCache[] = []
  for (const session of selection.selected) {
    const entry = outcome.entries.get(session.id)
    if (entry) selectedEntries.push(entry)
  }

  return {
    workspaceSlug: workspace.slug,
    usage: aggregateUsage(selectedEntries),
    coverage: buildCoverage(selection, selectedEntries, outcome.unreadable.size, now),
  }
}

/**
 * 读取（或增量重建）工作区 Skill 使用 summary。
 *
 * 内存缓存命中时直接返回；否则复用落盘缓存里活动时间未变化的会话，只重新解析
 * 新增或已变化的会话。缓存清理只删除已不存在的会话，窗口外的仍存在会话保留。
 */
export async function getSkillUsageSummary(
  workspace: SkillUsageWorkspace,
  deps: SkillUsageServiceDeps = {},
): Promise<SkillUsageSummary> {
  const resolved = await resolveDeps(deps)
  const now = resolved.now()
  const sessions = await resolved.listSessions()
  const selection = selectWorkspaceSessions(workspace, sessions)
  const skillsRoot = resolved.workspaceSkillsRoot(workspace)
  const signature = buildScanSignature(workspace, selection.selected, skillsRoot)

  const memo = memorySummaryCache.get(workspace.slug)
  if (memo?.signature === signature) {
    return { ...memo.summary, fromCache: true }
  }

  const cacheFile = normalizeCacheFile(resolved.readCache())
  const workspaceCache = getWorkspaceCache(cacheFile, workspace.slug)
  const cachedSessions = workspaceCache?.sessions ?? {}

  // 先保留所有仍存在会话的缓存，天然丢弃已删除/已移出本工作区的条目。
  const nextSessions: Record<string, SkillUsageSessionCache> = {}
  for (const session of selection.all) {
    if (Object.hasOwn(cachedSessions, session.id)) {
      nextSessions[session.id] = cachedSessions[session.id] as SkillUsageSessionCache
    }
  }

  const staleTargets = selection.selected.filter((session) => {
    const cached = nextSessions[session.id]
    return !cached || cached.activityAt !== getSessionActivityTime(session)
  })

  const outcome = await scanSessions(workspace, staleTargets, resolved)
  for (const [sessionId, entry] of outcome.entries) {
    nextSessions[sessionId] = entry
  }

  const selectedEntries: SkillUsageSessionCache[] = []
  for (const session of selection.selected) {
    const entry = nextSessions[session.id]
    if (entry) selectedEntries.push(entry)
  }

  const removedCachedSessions = Object.keys(cachedSessions).some((sessionId) => !nextSessions[sessionId])
  const shouldWriteCache = !workspaceCache || staleTargets.length > 0 || removedCachedSessions
  const updatedAt = shouldWriteCache ? now : (workspaceCache?.updatedAt ?? now)

  if (shouldWriteCache) {
    const nextWorkspaceCache: SkillUsageWorkspaceCache = {
      updatedAt,
      sessions: nextSessions,
    }
    const nextCacheFile: SkillUsageCacheFile = {
      version: SKILL_USAGE_CACHE_VERSION,
      workspaces: Object.fromEntries([
        ...Object.entries(cacheFile.workspaces),
        [workspace.slug, nextWorkspaceCache],
      ]),
    }
    try {
      resolved.writeCache(nextCacheFile)
    } catch (error) {
      console.warn('[Skill 使用统计] 写入缓存失败，本次结果仍可用:', error)
    }
  }

  const summary: SkillUsageSummary = {
    workspaceSlug: workspace.slug,
    usage: aggregateUsage(selectedEntries),
    coverage: buildCoverage(selection, selectedEntries, outcome.unreadable.size, now),
    fromCache: staleTargets.length === 0,
    updatedAt,
  }
  // 有读取失败时不写内存缓存，下一次调用可以重试失败会话而不是固化空结果。
  if (outcome.unreadable.size === 0) {
    memorySummaryCache.set(workspace.slug, { signature, summary })
  }
  return summary
}

/** 清除内存缓存；传入工作区 slug 时只清该工作区。落盘缓存的删除不由本服务自动执行。 */
export function invalidate(workspaceSlug?: string): void {
  if (workspaceSlug === undefined) {
    memorySummaryCache.clear()
    return
  }
  memorySummaryCache.delete(workspaceSlug)
}

/** `computeStaleSkills` 需要的最小 Skill 描述；`SkillMeta` 可直接传入。 */
export interface SkillUsageSkillRef {
  slug: string
  name?: string
}

/** 可接受 summary 对象或裸的 usage 映射。 */
export type SkillUsageLookupInput =
  | Pick<SkillUsageCollection, 'usage' | 'coverage'>
  | Record<string, SkillUsageStat>

/** 闲置 Skill 条目。 */
export interface StaleSkill {
  slug: string
  name: string
  /** 命中的 usage 键；无记录时为空。 */
  skillPath?: string
  /** 最近使用时间；undefined 表示统计范围内没有记录。 */
  lastUsedAt?: number
  useCount: number
  sessionsUsed: number
  /** `outside-window`：超过窗口未用；`no-recorded-use`：统计范围内无激活记录。 */
  reason: 'outside-window' | 'no-recorded-use'
}

/** 闲置判断使用的统计覆盖范围。 */
export interface StaleSkillsCoverage {
  scannedSessions: number
  earliestActivityAt: number
  truncated: boolean
  /** 覆盖范围内是否存在可观测历史；false 时不能断言任何 Skill「从未使用」。 */
  hasHistory: boolean
}

export interface StaleSkillsResult {
  staleSkills: StaleSkill[]
  coverage: StaleSkillsCoverage
  /** 覆盖范围内有历史时才为 true；否则调用方必须展示「暂无统计范围」。 */
  canAssertUnused: boolean
  days: number
  thresholdMs: number
  now: number
}

function isLookupInput(input: SkillUsageLookupInput): input is Pick<SkillUsageCollection, 'usage' | 'coverage'> {
  return isRecord(input) && isRecord(input.usage) && isRecord(input.coverage)
}

function findSkillUsage(
  usage: Record<string, SkillUsageStat>,
  slug: string,
): { skillPath: string; stat: SkillUsageStat } | undefined {
  const directKeys = [`${slug}/SKILL.md`, slug]
  for (const key of directKeys) {
    if (Object.hasOwn(usage, key)) {
      return { skillPath: key, stat: usage[key] as SkillUsageStat }
    }
  }

  for (const [skillPath, stat] of Object.entries(usage)) {
    if (skillPath.endsWith(`/skills/${slug}/SKILL.md`) || skillPath.endsWith(`/${slug}/SKILL.md`)) {
      return { skillPath, stat }
    }
  }
  return undefined
}

function emptyCoverage(): SkillUsageCoverage {
  return {
    scannedSessions: 0,
    totalWorkspaceSessions: 0,
    truncated: false,
    earliestActivityAt: 0,
    earliestUsedAt: 0,
    unreadableSessions: 0,
    computedAt: 0,
  }
}

/**
 * 计算闲置 Skill。
 *
 * 窗口按固定 30×24 小时计，`now - lastUsedAt === days × 24h` 视为已满窗口（计入闲置）。
 * 没有任何覆盖历史时不返回「闲置」结论，只返回 `canAssertUnused: false` 与范围信息。
 */
export function computeStaleSkills(
  skills: readonly SkillUsageSkillRef[],
  usage: SkillUsageLookupInput,
  now: number,
  days = SKILL_USAGE_STALE_DAYS,
): StaleSkillsResult {
  const normalized = isLookupInput(usage)
    ? { usage: usage.usage, coverage: usage.coverage }
    : { usage: usage, coverage: emptyCoverage() }
  const thresholdMs = days * DAY_MS
  const hasHistory = normalized.coverage.scannedSessions > 0
    || Object.keys(normalized.usage).length > 0
  const canAssertUnused = hasHistory

  const staleSkills: StaleSkill[] = []
  for (const skill of skills) {
    const match = findSkillUsage(normalized.usage, skill.slug)
    const lastUsedAt = match && match.stat.lastUsedAt > 0 ? match.stat.lastUsedAt : undefined

    if (lastUsedAt !== undefined) {
      if (now - lastUsedAt < thresholdMs) continue
      staleSkills.push({
        slug: skill.slug,
        name: skill.name?.trim() || skill.slug,
        skillPath: match?.skillPath,
        lastUsedAt,
        useCount: match?.stat.useCount ?? 0,
        sessionsUsed: match?.stat.sessionsUsed ?? 0,
        reason: 'outside-window',
      })
      continue
    }

    // 没有任何历史时无法区分「从未使用」与「尚未开始统计」，不下闲置结论。
    if (!hasHistory) continue
    staleSkills.push({
      slug: skill.slug,
      name: skill.name?.trim() || skill.slug,
      ...(match ? { skillPath: match.skillPath } : {}),
      useCount: match?.stat.useCount ?? 0,
      sessionsUsed: match?.stat.sessionsUsed ?? 0,
      reason: 'no-recorded-use',
    })
  }

  staleSkills.sort((a, b) => {
    const aTime = a.lastUsedAt ?? Number.POSITIVE_INFINITY
    const bTime = b.lastUsedAt ?? Number.POSITIVE_INFINITY
    if (aTime !== bTime) return aTime - bTime
    return a.slug.localeCompare(b.slug)
  })

  return {
    staleSkills,
    coverage: {
      scannedSessions: normalized.coverage.scannedSessions,
      earliestActivityAt: normalized.coverage.earliestActivityAt,
      truncated: normalized.coverage.truncated,
      hasHistory,
    },
    canAssertUnused,
    days,
    thresholdMs,
    now,
  }
}
