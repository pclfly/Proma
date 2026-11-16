/**
 * Pi-native Agent Memory 工具。
 *
 * 官方 0.22.0 的工具面：
 * MemoryInspect / MemoryInitialize / MemoryUpdate / MemorySearch /
 * MemoryHistory / MemoryMigrateProfile / MemoryArchive。
 *
 * 本实现复用：
 * - `agent-memory.ts` 的路径、版本、预算、历史、归档；
 * - `memory-entries.ts` 的条目增删改；
 * - `memory-search.ts` 的检索；
 * - `agent-memory-migration.ts` 的旧画像迁移。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  MAX_MEMORY_BYTES,
  PROFILE_MAX_CHARS,
  ProfileBudgetExceededError,
  archiveMemoryTheme,
  buildMemorySearchContext,
  discoverLegacyProfiles,
  ensureMemoryFiles,
  inspectLegacyProfileLocations,
  linkProjectMemory,
  listMemoryHistory,
  memoryPaths,
  memoryTarget,
  pendingMemoryMigrations,
  readGlobalProfile,
  readMemoryFile,
  readMemoryReview,
  updateMemory,
  updateMemoryEntries,
  withMemoryLock,
  type AgentMemoryContext,
  type MemoryFile,
} from '../agent-memory'
import {
  migrateProfile,
  replanProfileMigration,
  resumeProfileMigration,
  type MemoryMigrationProposal,
} from '../agent-memory-migration'
import type { MemoryEntryOperation } from '../memory-entries'
import { searchMemory } from '../memory-search'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface MemoryToolsOptions {
  /** 计划模式、自动化、委派子会话只暴露只读工具。 */
  readOnly?: boolean
}

export const MEMORY_TOOL_NAMES = [
  'MemoryInspect',
  'MemoryInitialize',
  'MemoryUpdate',
  'MemorySearch',
  'MemoryHistory',
  'MemoryMigrateProfile',
  'MemoryArchive',
] as const

const READ_ONLY_TOOL_NAMES: readonly string[] = ['MemoryInspect', 'MemorySearch', 'MemoryHistory']

function textResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }
}

function revisionSchema() {
  return Type.String({ minLength: 64, maxLength: 64 })
}

function contentSchema() {
  return Type.String({ minLength: 1, maxLength: MAX_MEMORY_BYTES })
}

function budget(content: string | null): {
  chars: number
  maxChars: number
  remainingChars: number
  unit: 'utf16'
} {
  const chars = content?.length ?? 0
  return {
    chars,
    maxChars: PROFILE_MAX_CHARS,
    remainingChars: Math.max(0, PROFILE_MAX_CHARS - chars),
    unit: 'utf16',
  }
}

function reconciliation(error: ProfileBudgetExceededError, operation: 'update' | 'migration'): object {
  return {
    status: 'reconciliation_required',
    saved: false,
    operation,
    attemptedChars: error.attemptedChars,
    maxChars: PROFILE_MAX_CHARS,
    next: operation === 'update'
      ? '本次更新未保存。可写用户会话应保留本次待记录事实与依据，重新用 MemoryInspect 读取最新 revision，再用 operations 逐条去重、合并到约 4000–4500 字符后重试并回读校验；不要为清除告警而丢失必要事实。只读、自动化及子会话不得主动重试。'
      : '迁移未执行。重新读取来源和画像，保留本次待合并事实及来源，整理至约 4000–4500 字符，再提交新的迁移提案。无法安全整理时保留原文并说明未完成。',
  }
}

interface InspectedMemoryFile extends MemoryFile {
  chars: number
  budget?: ReturnType<typeof budget>
  checkedAt?: number
  reviewDue: boolean
}

function inspectMemoryPath(ctx: AgentMemoryContext, path: string, profile: boolean): InspectedMemoryFile {
  const file = profile ? readGlobalProfile(ctx) : readMemoryFile(path)
  const review = readMemoryReview(ctx, file)
  return {
    ...file,
    chars: file.content?.length ?? 0,
    ...(profile ? { budget: budget(file.content) } : {}),
    ...(review.checkedAt !== undefined ? { checkedAt: review.checkedAt } : {}),
    reviewDue: review.reviewDue,
  }
}

interface MemoryInspectArgs {
  target?: string
  sourceId?: string
}

interface MemoryUpdateArgs {
  target: string
  revision: string
  content?: string
  operations?: MemoryEntryOperation[]
  summary: string
}

interface MemorySearchArgs {
  query: string
  limit?: number
}

interface MemoryHistoryArgs {
  target: string
  limit?: number
}

interface MemoryArchiveArgs {
  target: string
  revision: string
  indexRevision: string
  indexContent: string
}

interface MemoryMigrateArgs {
  resumeId?: string
  replanId?: string
  proposal?: MemoryMigrationProposal
}

/**
 * 构建记忆工具。
 *
 * `readOnly` 时只返回 MemoryInspect / MemorySearch / MemoryHistory；
 * MemoryMigrateProfile 还额外受 allowProfileMigration / allowInstructionMaintenance 约束。
 */
export function buildMemoryTools(
  sdk: PiSdk,
  ctx: AgentMemoryContext,
  options: MemoryToolsOptions = {},
): ToolDefinition[] {
  const readOnly = options.readOnly === true
  const allowProfileMigration = ctx.allowProfileMigration !== false && ctx.allowInstructionMaintenance !== false

  const tools = [
    sdk.defineTool({
      name: 'MemoryInspect',
      label: '读取记忆与迁移状态',
      description: 'Read the global Profile, project memory and review status. Profile includes its 5000-character budget and remaining space. Use target for a project theme or global-profile; sourceId reads a legacy profile and its project context. Read-only; does not mark reviewed.',
      parameters: Type.Object({
        target: Type.Optional(Type.String()),
        sourceId: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const args = params as MemoryInspectArgs
        if (args.target) {
          const path = memoryTarget(ctx, args.target)
          return textResult(inspectMemoryPath(ctx, path, args.target === 'global-profile'))
        }
        const { sources, issues } = inspectLegacyProfileLocations(ctx)
        const source = args.sourceId ? discoverLegacyProfiles(ctx, args.sourceId)[0] : undefined
        if (args.sourceId && !source) {
          throw new Error('未找到已登记的旧画像来源，请重新读取迁移列表。')
        }
        const sourceContext: AgentMemoryContext = source
          ? { ...ctx, workspaceRoot: source.workspace.root }
          : ctx
        const paths = memoryPaths(sourceContext)
        const files = [
          inspectMemoryPath(sourceContext, paths.profile, true),
          inspectMemoryPath(sourceContext, memoryTarget(sourceContext, 'MEMORY.md'), false),
          inspectMemoryPath(sourceContext, memoryTarget(sourceContext, 'project-preferences.md'), false),
        ]
        return textResult({
          files,
          ...(source ? { source } : {}),
          legacyProfiles: sources.map((item) => ({
            id: item.id,
            workspace: item.workspace.slug,
            path: item.path,
          })),
          migrationIssues: issues,
          pendingMigrations: pendingMemoryMigrations(ctx),
        })
      },
    }),
    sdk.defineTool({
      name: 'MemoryInitialize',
      label: '建立必需记忆与项目关联',
      description: 'Ensure the global user_profile.md and current project MEMORY.md exist with truthful scaffolding; append an explicit memory maintenance section and absolute links to the current project AGENTS.md, preserving existing rules and CLAUDE.md entry. Use during writable project work, not read-only/plan tasks. Afterwards fill project facts and confirmed user facts; do not invent a profile.',
      parameters: Type.Object({}),
      async execute() {
        ensureMemoryFiles(ctx)
        withMemoryLock(ctx, () => linkProjectMemory(ctx))
        return textResult(memoryPaths(ctx))
      },
    }),
    sdk.defineTool({
      name: 'MemoryUpdate',
      label: '更新或核验记忆',
      description: 'Version-checked memory update. Prefer `operations` to add/update/remove single `- ` entries so unrelated text is preserved; use `content` only for a full rewrite or review pass. For global-profile, write concise core user facts: one short fact per item, at most 5000 UTF-16 code units; merge duplicates, retain necessary scope and sources, and correct outdated facts without guessing. Project-only facts belong to the authorized project. If reconciliation_required, nothing was saved: retain the pending facts, inspect, reconcile to about 4000–4500 characters, retry with the latest revision and verify. Preserve unrelated facts and history; report if unsafe to reconcile. Unchanged content records review; update MEMORY.md when theme routes change. Do not use for profile migration.',
      parameters: Type.Object({
        target: Type.String(),
        revision: revisionSchema(),
        content: Type.Optional(contentSchema()),
        operations: Type.Optional(Type.Array(
          Type.Union([
            Type.Object({
              op: Type.Literal('add'),
              entry: Type.String({ minLength: 1, maxLength: 2_000 }),
              after: Type.Optional(Type.String({ maxLength: 500 })),
            }),
            Type.Object({
              op: Type.Literal('update'),
              match: Type.String({ minLength: 1, maxLength: 500 }),
              entry: Type.String({ minLength: 1, maxLength: 2_000 }),
            }),
            Type.Object({
              op: Type.Literal('remove'),
              match: Type.String({ minLength: 1, maxLength: 500 }),
            }),
          ]),
          { minItems: 1, maxItems: 50 },
        )),
        summary: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      async execute(_id, params) {
        const args = params as MemoryUpdateArgs
        if (!args.content?.trim() && !args.operations?.length) {
          throw new Error('请提供 content 或至少一条条目操作。')
        }
        if (args.content?.trim() && args.operations?.length) {
          throw new Error('content 与 operations 只能二选一：整篇替换或条目操作。')
        }
        try {
          const result = args.operations?.length
            ? updateMemoryEntries(ctx, args.target, args.revision, args.operations, args.summary)
            : updateMemory(ctx, args.target, args.revision, args.content ?? '', args.summary)
          return textResult(result)
        } catch (error) {
          if (error instanceof ProfileBudgetExceededError) return textResult(reconciliation(error, 'update'))
          throw error
        }
      },
    }),
    sdk.defineTool({
      name: 'MemorySearch',
      label: '检索记忆片段',
      description: 'Search the global profile and current project memory/*.md by keywords and return line-level snippets with file, line and score. Use it when the MEMORY.md index is long or you are unsure which topic file holds a fact; read the full file only when the snippet is insufficient. Read-only.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      }),
      async execute(_id, params) {
        const args = params as MemorySearchArgs
        if (!args.query.trim()) throw new Error('请提供检索关键词。')
        return textResult(searchMemory(buildMemorySearchContext(ctx), args.query, args.limit ?? 8))
      },
    }),
    sdk.defineTool({
      name: 'MemoryHistory',
      label: '查看记忆历史版本',
      description: 'List saved versions of a memory target (global-profile, MEMORY.md or a memory/*.md theme) with time, write summary and size. Read-only; restoring a version is a user action in the Memory page.',
      parameters: Type.Object({
        target: Type.String(),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      }),
      async execute(_id, params) {
        const args = params as MemoryHistoryArgs
        return textResult({
          target: args.target,
          versions: listMemoryHistory(ctx, args.target, args.limit ?? 20),
        })
      },
    }),
    sdk.defineTool({
      name: 'MemoryMigrateProfile',
      label: '合并旧画像并更新原项目索引',
      description: 'Read MemoryInspect sourceId, then semantically merge ONE legacy profile. Keep concise core user facts in global-profile (at most 5000 UTF-16 code units); preserve provenance, unrelated facts and indexes, and put project-only facts in the source project. Never resolve conflicts by mtime. On reconciliation_required, retain pending facts, reorganize and resubmit. For a pending migration use resumeId; on conflict use replanId, re-inspect and merge again. Do not claim completion while migrationIssues, sources or pending records remain.',
      parameters: Type.Object({
        resumeId: Type.Optional(Type.String()),
        replanId: Type.Optional(Type.String()),
        proposal: Type.Optional(Type.Object({
          sourceId: Type.String(),
          sourceRevision: revisionSchema(),
          globalRevision: revisionSchema(),
          globalContent: contentSchema(),
          preferencesRevision: revisionSchema(),
          preferencesContent: Type.Union([contentSchema(), Type.Null()]),
          sourceIndexRevision: revisionSchema(),
          sourceIndexContent: contentSchema(),
          indexRevision: revisionSchema(),
          indexContent: contentSchema(),
          rationale: Type.String({ minLength: 1, maxLength: 12_000 }),
        })),
      }),
      async execute(_id, params) {
        const args = params as MemoryMigrateArgs
        if ([args.resumeId, args.replanId, args.proposal].filter(Boolean).length !== 1) {
          throw new Error('请提供 proposal、resumeId 或 replanId 中的一个。')
        }
        if (args.replanId) {
          return textResult({
            supersededId: replanProfileMigration(ctx, args.replanId),
            status: 'needs-merge',
            next: '使用 MemoryInspect 重新读取当前来源和版本，保留新编辑后再次语义合并；原计划和 before/after 历史保留在 superseded.json。',
          })
        }
        try {
          return textResult({
            migrationId: args.resumeId
              ? resumeProfileMigration(ctx, args.resumeId)
              : migrateProfile(ctx, args.proposal as MemoryMigrationProposal),
          })
        } catch (error) {
          if (error instanceof ProfileBudgetExceededError) return textResult(reconciliation(error, 'migration'))
          throw error
        }
      },
    }),
    sdk.defineTool({
      name: 'MemoryArchive',
      label: '归档过期记忆主题',
      description: 'Recoverably archive an actually expired or superseded non-core current-project theme (including legacy project-preferences.md after its active rules are merged into AGENTS.md or topic files), while replacing MEMORY.md with a version-checked index that removes its active route. Preserve unrelated index entries. Use only after verifying evidence; age alone is not expiry. Core global-profile and MEMORY.md must be revised by entry using MemoryUpdate instead.',
      parameters: Type.Object({
        target: Type.String(),
        revision: revisionSchema(),
        indexRevision: revisionSchema(),
        indexContent: contentSchema(),
      }),
      async execute(_id, params) {
        const args = params as MemoryArchiveArgs
        return textResult({
          archive: archiveMemoryTheme(ctx, args.target, args.revision, args.indexRevision, args.indexContent),
        })
      },
    }),
  ] as unknown as ToolDefinition[]

  return tools.filter((tool) =>
    (readOnly ? READ_ONLY_TOOL_NAMES.includes(tool.name) : true)
    && (allowProfileMigration || tool.name !== 'MemoryMigrateProfile'),
  )
}
