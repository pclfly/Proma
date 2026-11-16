import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import {
  SKILL_USAGE_CACHE_VERSION,
  collectSkillUsage,
  computeStaleSkills,
  getSkillUsageSummary,
  invalidate,
} from './skill-usage-service'
import type {
  SkillUsageCacheFile,
  SkillUsageCoverage,
  SkillUsageServiceDeps,
} from './skill-usage-service'

const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const WORKSPACE = { id: 'ws-a', slug: 'ws-a' }
const WORKSPACE_SKILLS_ROOT = 'C:/proma/agent-workspaces/ws-a/skills'

afterEach(() => {
  invalidate()
})

interface HarnessOptions {
  sessions: AgentSessionMeta[]
  messages?: Record<string, readonly unknown[]>
  cache?: SkillUsageCacheFile | null
  now?: number
  delayMs?: number
  workspaceSkillsRoot?: string
  failSessions?: string[]
}

interface Harness {
  deps: SkillUsageServiceDeps
  readCalls: string[]
  writes: SkillUsageCacheFile[]
  maxActiveReads: () => number
}

function makeSession(overrides: Partial<AgentSessionMeta> & { id: string }): AgentSessionMeta {
  return {
    title: overrides.id,
    createdAt: 0,
    updatedAt: overrides.lastActivityAt ?? 0,
    workspaceId: WORKSPACE.id,
    ...overrides,
  }
}

function createHarness(options: HarnessOptions): Harness {
  const readCalls: string[] = []
  const writes: SkillUsageCacheFile[] = []
  let activeReads = 0
  let maxActiveReads = 0

  const deps: SkillUsageServiceDeps = {
    listSessions: () => options.sessions,
    readSessionMessages: async (sessionId) => {
      readCalls.push(sessionId)
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        if (options.failSessions?.includes(sessionId)) throw new Error(`模拟读取失败: ${sessionId}`)
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        else await Promise.resolve()
        return options.messages?.[sessionId] ?? []
      } finally {
        activeReads -= 1
      }
    },
    now: () => options.now ?? NOW,
    readCache: () => options.cache ?? null,
    writeCache: (cache) => { writes.push(cache) },
    workspaceSkillsRoot: () => options.workspaceSkillsRoot ?? WORKSPACE_SKILLS_ROOT,
  }

  return { deps, readCalls, writes, maxActiveReads: () => maxActiveReads }
}

function activationUser(slug: string, workspaceSlug = WORKSPACE.slug): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text: '展开 Skill' }] },
    parent_tool_use_id: null,
    skill_activations: [{
      slug,
      name: `${slug} Skill`,
      workspaceSlug,
      workspaceSkillPath: `${slug}/SKILL.md`,
      sources: ['explicit'],
    }],
  }
}

function textUser(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

function cachedSession(activityAt: number, activations: Array<{ skillPath: string; skillName: string; activatedAt: number }>) {
  return { activityAt, activations }
}

function makeCache(workspaces: SkillUsageCacheFile['workspaces']): SkillUsageCacheFile {
  return { version: SKILL_USAGE_CACHE_VERSION, workspaces }
}

function makeCoverage(overrides: Partial<SkillUsageCoverage> = {}): SkillUsageCoverage {
  return {
    scannedSessions: 12,
    totalWorkspaceSessions: 12,
    truncated: false,
    earliestActivityAt: NOW - 90 * DAY_MS,
    earliestUsedAt: NOW - 60 * DAY_MS,
    unreadableSessions: 0,
    computedAt: NOW,
    ...overrides,
  }
}

describe('Skill 使用统计采集', () => {
  test('Given 一个会话真实激活而另一个只提到名称 When 采集 Then 只有真实激活计入', async () => {
    const harness = createHarness({
      sessions: [
        makeSession({ id: 'session-active', lastActivityAt: NOW - 2000 }),
        makeSession({ id: 'session-mention', lastActivityAt: NOW - 1000 }),
      ],
      messages: {
        'session-active': [activationUser('demo')],
        'session-mention': [textUser('这里提到 demo skill 和 skills/demo/SKILL.md，但没有激活。')],
      },
    })

    const result = await collectSkillUsage(WORKSPACE, harness.deps)

    expect(result.usage).toEqual({
      'demo/SKILL.md': { lastUsedAt: NOW - 2000, useCount: 1, sessionsUsed: 1 },
    })
    expect(result.coverage.scannedSessions).toBe(2)
    expect(result.coverage.earliestActivityAt).toBe(NOW - 2000)
    expect(result.coverage.truncated).toBe(false)
  })

  test('Given 另一个工作区也有同名 Skill When 采集当前工作区 Then 不读取也不混入其它工作区', async () => {
    const otherRoot = 'C:/proma/agent-workspaces/ws-b/skills'
    const harness = createHarness({
      sessions: [
        makeSession({ id: 'session-own', lastActivityAt: NOW - 100 }),
        makeSession({ id: 'session-foreign-claim', lastActivityAt: NOW - 200 }),
        makeSession({ id: 'session-other-workspace', workspaceId: 'ws-b', lastActivityAt: NOW - 50 }),
      ],
      messages: {
        'session-own': [activationUser('demo')],
        'session-foreign-claim': [{
          type: 'user',
          parent_tool_use_id: null,
          skill_activations: [{
            slug: 'demo',
            name: 'Demo Skill',
            filePath: `${otherRoot}/demo/SKILL.md`,
            sources: ['read'],
          }],
        }],
        'session-other-workspace': [activationUser('demo', 'ws-b')],
      },
    })

    const result = await collectSkillUsage(WORKSPACE, harness.deps)

    expect(result.usage).toEqual({
      'demo/SKILL.md': { lastUsedAt: NOW - 100, useCount: 1, sessionsUsed: 1 },
    })
    expect(harness.readCalls).not.toContain('session-other-workspace')
  })

  test('Given 工作区有 405 个会话 When 采集 Then 只扫描最近 400 个且并发不超过 4', async () => {
    const sessions: AgentSessionMeta[] = []
    const messages: Record<string, readonly unknown[]> = {}

    for (let index = 0; index < 405; index++) {
      const id = `session-${index}`
      sessions.push(makeSession({ id, lastActivityAt: 100_000 - index }))
      messages[id] = [activationUser(index < 400 ? 'bulk' : 'ancient')]
    }

    const harness = createHarness({ sessions, messages, delayMs: 1, now: 200_000 })
    const result = await collectSkillUsage(WORKSPACE, harness.deps)

    expect(result.usage['bulk/SKILL.md']).toEqual({
      lastUsedAt: 100_000,
      useCount: 400,
      sessionsUsed: 400,
    })
    expect(result.usage['ancient/SKILL.md']).toBeUndefined()
    expect(result.coverage.scannedSessions).toBe(400)
    expect(result.coverage.totalWorkspaceSessions).toBe(405)
    expect(result.coverage.truncated).toBe(true)
    expect(harness.readCalls).toHaveLength(400)
    expect(harness.maxActiveReads()).toBeLessThanOrEqual(4)
    expect(harness.maxActiveReads()).toBeGreaterThan(1)
  })
})

describe('Skill 使用统计缓存', () => {
  test('Given 缓存包含已消失会话 When 生成 summary Then 只清理消失会话并保留其它工作区缓存', async () => {
    const harness = createHarness({
      sessions: [
        makeSession({ id: 'session-1', lastActivityAt: 100 }),
        makeSession({ id: 'session-2', lastActivityAt: 200 }),
      ],
      cache: makeCache({
        'ws-a': {
          updatedAt: 50,
          sessions: {
            'session-1': cachedSession(100, [{ skillPath: 'demo/SKILL.md', skillName: 'Demo Skill', activatedAt: 100 }]),
            'session-2': cachedSession(200, [{ skillPath: 'demo/SKILL.md', skillName: 'Demo Skill', activatedAt: 200 }]),
            'session-deleted': cachedSession(300, [{ skillPath: 'other/SKILL.md', skillName: 'Other', activatedAt: 300 }]),
          },
        },
        'ws-b': {
          updatedAt: 60,
          sessions: {
            'session-b': cachedSession(400, [{ skillPath: 'b-skill/SKILL.md', skillName: 'B', activatedAt: 400 }]),
          },
        },
      }),
    })

    const summary = await getSkillUsageSummary(WORKSPACE, harness.deps)

    expect(summary.usage).toEqual({
      'demo/SKILL.md': { lastUsedAt: 200, useCount: 2, sessionsUsed: 2 },
    })
    expect(summary.fromCache).toBe(true)
    expect(harness.readCalls).toEqual([])
    expect(harness.writes).toHaveLength(1)

    const written = harness.writes[0]
    expect(written?.workspaces['ws-a']?.sessions['session-deleted']).toBeUndefined()
    expect(Object.keys(written?.workspaces['ws-a']?.sessions ?? {}).sort()).toEqual(['session-1', 'session-2'])
    expect(written?.workspaces['ws-b']?.sessions['session-b']).toBeDefined()
  })

  test('Given 部分会话活动时间变化 When 生成 summary Then 只重新读取变化会话并复用其余缓存', async () => {
    const harness = createHarness({
      sessions: [
        makeSession({ id: 'session-stable', lastActivityAt: 100 }),
        makeSession({ id: 'session-changed', lastActivityAt: 300 }),
      ],
      messages: {
        'session-changed': [activationUser('fresh')],
      },
      cache: makeCache({
        'ws-a': {
          updatedAt: 50,
          sessions: {
            'session-stable': cachedSession(100, [{ skillPath: 'stable/SKILL.md', skillName: 'Stable', activatedAt: 100 }]),
            'session-changed': cachedSession(200, [{ skillPath: 'stale/SKILL.md', skillName: 'Stale', activatedAt: 200 }]),
          },
        },
      }),
    })

    const summary = await getSkillUsageSummary(WORKSPACE, harness.deps)

    expect(harness.readCalls).toEqual(['session-changed'])
    expect(summary.usage['stable/SKILL.md']).toEqual({ lastUsedAt: 100, useCount: 1, sessionsUsed: 1 })
    expect(summary.usage['fresh/SKILL.md']).toEqual({ lastUsedAt: 300, useCount: 1, sessionsUsed: 1 })
    expect(summary.usage['stale/SKILL.md']).toBeUndefined()
    expect(summary.fromCache).toBe(false)
  })

  test('Given 缓存版本不匹配 When 生成 summary Then 视为空缓存重新扫描并写入新版本', async () => {
    const harness = createHarness({
      sessions: [makeSession({ id: 'session-1', lastActivityAt: 100 })],
      messages: { 'session-1': [activationUser('demo')] },
      cache: {
        version: SKILL_USAGE_CACHE_VERSION - 1,
        workspaces: {
          'ws-a': {
            updatedAt: 50,
            sessions: {
              'session-deleted': cachedSession(10, [{ skillPath: 'old/SKILL.md', skillName: 'Old', activatedAt: 10 }]),
            },
          },
        },
      },
    })

    const summary = await getSkillUsageSummary(WORKSPACE, harness.deps)

    expect(harness.readCalls).toEqual(['session-1'])
    expect(summary.usage['demo/SKILL.md']).toEqual({ lastUsedAt: 100, useCount: 1, sessionsUsed: 1 })
    expect(harness.writes[0]?.version).toBe(SKILL_USAGE_CACHE_VERSION)
    expect(harness.writes[0]?.workspaces['ws-a']?.sessions['session-deleted']).toBeUndefined()
  })

  test('Given 会话读取失败 When 生成 summary Then 不计入使用且不缓存空结果', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const harness = createHarness({
        sessions: [
          makeSession({ id: 'session-ok', lastActivityAt: 100 }),
          makeSession({ id: 'session-broken', lastActivityAt: 200 }),
        ],
        messages: { 'session-ok': [activationUser('demo')] },
        failSessions: ['session-broken'],
      })

      const first = await getSkillUsageSummary(WORKSPACE, harness.deps)

      expect(first.usage['demo/SKILL.md']).toEqual({ lastUsedAt: 100, useCount: 1, sessionsUsed: 1 })
      expect(first.coverage.unreadableSessions).toBe(1)
      expect(harness.writes.at(-1)?.workspaces['ws-a']?.sessions['session-broken']).toBeUndefined()

      // 失败会话不被内存缓存固化，下一次调用会重试同一个会话。
      await getSkillUsageSummary(WORKSPACE, harness.deps)
      expect(harness.readCalls.filter((sessionId) => sessionId === 'session-broken')).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  test('Given 同一签名重复请求 When 生成 summary Then 命中内存缓存且 invalidate 后重新读取', async () => {
    const workspace = { id: 'ws-memo', slug: 'ws-memo' }
    const harness = createHarness({
      sessions: [makeSession({ id: 'session-1', workspaceId: 'ws-memo', lastActivityAt: 100 })],
      messages: { 'session-1': [activationUser('demo', 'ws-memo')] },
      workspaceSkillsRoot: 'C:/proma/agent-workspaces/ws-memo/skills',
    })

    const first = await getSkillUsageSummary(workspace, harness.deps)
    const second = await getSkillUsageSummary(workspace, harness.deps)

    expect(first.fromCache).toBe(false)
    expect(second.fromCache).toBe(true)
    expect(harness.readCalls).toEqual(['session-1'])

    invalidate('ws-memo')
    await getSkillUsageSummary(workspace, harness.deps)
    expect(harness.readCalls).toHaveLength(2)
  })
})

describe('闲置 Skill 计算', () => {
  test('Given 正好 30 天未用 When 计算闲置 Then 计入闲置且 30 天减 1ms 不计入', () => {
    const usage = {
      'exactly-30/SKILL.md': { lastUsedAt: NOW - 30 * DAY_MS, useCount: 4, sessionsUsed: 2 },
      'almost-30/SKILL.md': { lastUsedAt: NOW - 30 * DAY_MS + 1, useCount: 1, sessionsUsed: 1 },
      'old/SKILL.md': { lastUsedAt: NOW - 45 * DAY_MS, useCount: 2, sessionsUsed: 1 },
    }

    const result = computeStaleSkills([
      { slug: 'exactly-30', name: 'Exactly 30' },
      { slug: 'almost-30', name: 'Almost 30' },
      { slug: 'old', name: 'Old' },
      { slug: 'never', name: 'Never' },
    ], { usage, coverage: makeCoverage() }, NOW)

    expect(result.days).toBe(30)
    expect(result.thresholdMs).toBe(30 * DAY_MS)
    expect(result.canAssertUnused).toBe(true)
    expect(result.coverage.hasHistory).toBe(true)
    expect(result.staleSkills.map((skill) => skill.slug)).toEqual(['old', 'exactly-30', 'never'])
    expect(result.staleSkills[0]).toEqual({
      slug: 'old',
      name: 'Old',
      skillPath: 'old/SKILL.md',
      lastUsedAt: NOW - 45 * DAY_MS,
      useCount: 2,
      sessionsUsed: 1,
      reason: 'outside-window',
    })
    expect(result.staleSkills[1]?.reason).toBe('outside-window')
    expect(result.staleSkills[2]).toEqual({
      slug: 'never',
      name: 'Never',
      useCount: 0,
      sessionsUsed: 0,
      reason: 'no-recorded-use',
    })
  })

  test('Given 工作区没有任何历史 When 生成闲置视图 Then 标注统计范围且不断言从未使用', async () => {
    const harness = createHarness({ sessions: [] })
    const summary = await getSkillUsageSummary(WORKSPACE, harness.deps)
    const result = computeStaleSkills([{ slug: 'demo', name: 'Demo' }], summary, NOW)

    expect(summary.coverage.scannedSessions).toBe(0)
    expect(summary.coverage.earliestActivityAt).toBe(0)
    expect(result.staleSkills).toEqual([])
    expect(result.canAssertUnused).toBe(false)
    expect(result.coverage.hasHistory).toBe(false)
  })

  test('Given 有历史范围内从未激活 When 计算闲置 Then 标为统计范围内无记录而不是从未使用', () => {
    const result = computeStaleSkills(
      [{ slug: 'demo', name: 'Demo' }],
      { usage: {}, coverage: makeCoverage({ scannedSessions: 3, totalWorkspaceSessions: 3 }) },
      NOW,
    )

    expect(result.canAssertUnused).toBe(true)
    expect(result.coverage.hasHistory).toBe(true)
    expect(result.staleSkills).toEqual([{
      slug: 'demo',
      name: 'Demo',
      useCount: 0,
      sessionsUsed: 0,
      reason: 'no-recorded-use',
    }])
  })
})
