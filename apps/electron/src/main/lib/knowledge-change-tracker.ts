/**
 * 记忆/项目规则变更追踪。
 *
 * 官方 0.22.0 在同步记忆工具与文件/Shell 工具执行前后采样目标文件，
 * 只有真实内容变化才产生变更记录。追踪器不扩展写入授权：
 * - 所有路径先经过 resolveMemoryPath，符号链接不能把写入带出记忆根；
 * - 只追踪记忆主题、全局画像、AGENTS.md/CLAUDE.md 与显式文件写入；
 * - 单次最多记录 128 个目标，异常一律忽略，不阻断原工具。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrackedKnowledgeChange } from '@proma/shared'
import {
  memoryPaths,
  memoryTarget,
  type AgentMemoryContext,
} from './agent-memory'
import { createFileChange, readFileChangeSnapshot } from './file-change-diff'
import { resolveMemoryPath } from './memory-file-path'

export const INSTRUCTION_MUTATIONS = new Set([
  'ProjectInstructionsMaintain',
  'ProjectInstructionsMigrate',
  'ProjectInstructionsResume',
  'ProjectInstructionsReplan',
])

export const SHELL_MUTATION = /(?:^|[\s;&|])(?:rm|mv|cp|tee|touch|sed\s+-i|perl\s+-[\w]*i|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item)\b|(?:>|>>)|(?:writeFile|write_text|write_bytes|\.write\()/i

export const MAX_KNOWLEDGE_CHANGE_TARGETS = 128

const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'Write', 'Edit', 'MultiEdit'])
const SHELL_TOOLS = new Set(['bash', 'Bash', 'powershell', 'PowerShell'])

export interface KnowledgeChangeTrackerOptions {
  memoryContext?: AgentMemoryContext
  cwd: string
  additionalDirectories?: string[]
  onChanges: (changes: TrackedKnowledgeChange[]) => void
}

export interface KnowledgeChangeTracker {
  classify: (rawPath: string) => { path: string; label: string } | undefined
  targets: (toolName: string, params: Record<string, unknown>) => Array<{ path: string; label: string }>
  begin: (toolName: string, params: Record<string, unknown>) => () => void
  run: <T>(
    toolName: string,
    params: Record<string, unknown>,
    execute: () => Promise<T>,
  ) => Promise<T>
  runSynchronous: <T>(
    toolName: string,
    params: Record<string, unknown>,
    execute: () => T,
  ) => T
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 归一化 Agent 工具传入的路径：@ 前缀、Windows 盘符、~ 与 file://。 */
export function resolveKnowledgeToolPath(raw: string, cwd: string): string {
  let value = raw
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/^@/, '')
  if (process.platform === 'win32' && !value.includes('\\')) {
    value = value.replace(
      /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i,
      (_match, drive: string) => `${drive.toUpperCase()}:\\`,
    )
  }
  if (value === '~') value = homedir()
  else if (/^~[\/\\]/.test(value)) value = join(homedir(), value.slice(2))
  if (value.startsWith('file://')) value = fileURLToPath(value)
  return resolve(cwd, value)
}

function canonicalPath(path: string): string {
  return resolveMemoryPath(path)
}

function safeCanonicalPath(path: string): string | undefined {
  try {
    return canonicalPath(path)
  } catch {
    return undefined
  }
}

function withinSafeRoot(root: string, path: string): boolean {
  const canonical = safeCanonicalPath(root)
  return canonical !== undefined && within(canonical, path)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function toTrackedChange(
  change: NonNullable<ReturnType<typeof createFileChange>>,
  absolutePath: string,
): TrackedKnowledgeChange {
  const diff = change.diff
    ? {
        context: change.diff.hunks.flatMap((hunk) => hunk.context).slice(0, 8),
        removed: change.diff.hunks
          .flatMap((hunk) => hunk.removed.map((line) => line.text))
          .slice(0, 8),
        added: change.diff.hunks
          .flatMap((hunk) => hunk.added.map((line) => line.text))
          .slice(0, 8),
        truncated: change.diff.truncated
          || change.diff.hunks.length > 1
          || change.diff.removedTotal > 8
          || change.diff.addedTotal > 8,
      }
    : undefined
  return {
    absolutePath,
    relativePath: change.relativePath,
    kind: change.kind,
    changedAt: change.changedAt,
    diffAvailable: change.diffAvailable,
    ...(change.preview !== undefined ? { preview: change.preview } : {}),
    ...(diff ? { diff } : {}),
  }
}

/** 为一次 Agent turn 创建变更追踪器；工具执行前后真正变化才回调。 */
export function createKnowledgeChangeTracker(
  options: KnowledgeChangeTrackerOptions,
): KnowledgeChangeTracker {
  const ctx = options.memoryContext
  const roots = [options.cwd, ...options.additionalDirectories ?? [], ...(ctx ? [ctx.projectRoot] : [])]

  function classify(raw: string): { path: string; label: string } | undefined {
    const logical = resolveKnowledgeToolPath(raw, options.cwd)
    const path = canonicalPath(logical)
    if (ctx && path === safeCanonicalPath(memoryPaths(ctx).profile)) {
      return { path: logical, label: '全局画像/user_profile.md' }
    }
    const workspaces = ctx
      ? [
          { root: ctx.workspaceRoot, slug: '' },
          ...(ctx.allowProfileMigration === false ? [] : ctx.workspaces),
        ]
      : []
    for (const workspace of workspaces) {
      const logicalRoot = join(workspace.root, 'memory')
      const memory = safeCanonicalPath(logicalRoot)
      const isLogical = within(logicalRoot, logical)
      if (memory && (isLogical || within(memory, path)) && /\.md$/i.test(logical)) {
        const relativePath = relative(
          isLogical ? logicalRoot : memory,
          isLogical ? logical : path,
        ).split(sep).join('/')
        if (relativePath.split('/').some((part) => part.startsWith('.') || part === 'archive')) {
          return undefined
        }
        return {
          path: logical,
          label: workspace.slug
            ? `${workspace.slug}/memory/${relativePath}`
            : `项目记忆/${relativePath}`,
        }
      }
      if (
        /^(user[_-]profile|MEMORY)\.md$/i.test(basename(path))
        && withinSafeRoot(join(workspace.root, '.claude', 'memory'), path)
      ) {
        return {
          path,
          label: `${workspace.slug || '当前项目'}/旧画像/${basename(path)}`,
        }
      }
    }
    if (
      /^(AGENTS|CLAUDE)\.md$/i.test(basename(path))
      && (
        roots.some((root) => withinSafeRoot(root, path))
        || (ctx ? withinSafeRoot(ctx.workspaceRoot, path) : false)
      )
    ) {
      return { path, label: `项目规则/${basename(path)}` }
    }
    return undefined
  }

  function targets(
    name: string,
    params: Record<string, unknown>,
  ): Array<{ path: string; label: string }> {
    const paths: string[] = []
    const addCore = () => {
      if (!ctx) return
      const p = memoryPaths(ctx)
      const map = join(
        ctx.projectRoot,
        existsSync(join(ctx.projectRoot, 'AGENTS.md'))
          || !existsSync(join(ctx.projectRoot, 'AGENTS.MD'))
          ? 'AGENTS.md'
          : 'AGENTS.MD',
      )
      paths.push(p.profile, p.index, p.preferences, map)
    }
    if (ctx && name === 'MemoryUpdate' && typeof params.target === 'string') {
      paths.push(memoryTarget(ctx, params.target))
    } else if (ctx && name === 'MemoryArchive' && typeof params.target === 'string') {
      paths.push(memoryTarget(ctx, params.target), memoryPaths(ctx).index)
    } else if (name === 'MemoryInitialize') {
      addCore()
    } else if (ctx && INSTRUCTION_MUTATIONS.has(name)) {
      addCore()
      paths.push(join(ctx.workspaceRoot, 'AGENTS.md'), join(ctx.workspaceRoot, 'AGENTS.MD'))
    } else if (ctx && name === 'MemoryMigrateProfile') {
      const proposal = asRecord(params.proposal)
      let sourceId = typeof proposal?.sourceId === 'string' ? proposal.sourceId : undefined
      const migrationId = params.resumeId ?? params.replanId
      if (typeof migrationId === 'string' && /^[a-f0-9-]{36}$/.test(migrationId)) {
        const journalPath = join(ctx.globalDir, 'migrations', migrationId, 'pending.json')
        try {
          if (lstatSync(journalPath).size <= 8 * 1024 * 1024) {
            const journal = asRecord(JSON.parse(readFileSync(journalPath, 'utf8')))
            if (typeof journal?.sourceId === 'string') sourceId = journal.sourceId
          }
        } catch {
          // 迁移日志缺失/不可读时只按显式 proposal 处理。
        }
      }
      for (const workspace of ctx.allowProfileMigration === false ? [] : ctx.workspaces) {
        for (const folder of ['memory', '.claude/memory']) {
          for (const filename of ['user_profile.md', 'user-profile.md']) {
            const sourcePath = join(workspace.root, folder, filename)
            const id = createHash('sha256').update(resolve(sourcePath)).digest('hex')
            if (id !== sourceId) continue
            const p = memoryPaths({ ...ctx, workspaceRoot: workspace.root })
            paths.push(
              p.profile,
              p.index,
              p.preferences,
              sourcePath,
              join(dirname(sourcePath), 'MEMORY.md'),
            )
          }
        }
      }
    } else if (FILE_WRITE_TOOLS.has(name)) {
      const raw = params.path ?? params.file_path ?? params.filePath
      if (typeof raw === 'string') paths.push(raw)
    } else if (
      SHELL_TOOLS.has(name)
      && typeof params.command === 'string'
      && SHELL_MUTATION.test(params.command)
    ) {
      let commandCwd: string | undefined = options.cwd
      for (const segment of params.command.split(/&&|;|\n/)) {
        const cd = segment.match(
          /^\s*(?:cd|Set-Location)\s+(?:--\s+)?(?:(?:"([^"\n]+)")|(?:'([^'\n]+)')|([^\s]+))\s*$/i,
        )
        if (cd) {
          const raw = cd[1] ?? cd[2] ?? cd[3] ?? ''
          commandCwd = commandCwd && raw !== '-' && !/[$`*?]/.test(raw)
            ? resolveKnowledgeToolPath(raw, commandCwd)
            : undefined
          continue
        }
        const quoted = [...segment.matchAll(/(["'])([^"'\r\n]*?\.md)\1/gi)]
          .map((match) => match[2])
        const unquoted = [...segment.matchAll(/[^\s"'();|<>]+\.md\b/gi)]
          .map((match) => match[0])
        for (const raw of [...quoted, ...unquoted]) {
          if (!raw || /[$`*?]/.test(raw)) continue
          if (commandCwd || isAbsolute(raw)) {
            paths.push(resolveKnowledgeToolPath(raw, commandCwd ?? options.cwd))
          }
        }
      }
    }
    const unique = new Map<string, { path: string; label: string }>()
    for (const path of paths) {
      try {
        const target = classify(path)
        if (!target) continue
        const identity = canonicalPath(target.path)
        if (!unique.has(identity)) unique.set(identity, target)
      } catch {
        // 单个目标不可解析不能阻断其它目标。
      }
      if (unique.size >= MAX_KNOWLEDGE_CHANGE_TARGETS) break
    }
    return [...unique.values()]
  }

  function begin(name: string, params: Record<string, unknown>): () => void {
    const before = new Map<{ path: string; label: string }, ReturnType<typeof readFileChangeSnapshot>>()
    try {
      for (const target of targets(name, params)) {
        try {
          // 解析失败/越界目标直接跳过，绝不对未授权路径采样。
          canonicalPath(target.path)
          before.set(target, readFileChangeSnapshot(canonicalPath(target.path)))
        } catch {
          // 忽略单目标失败。
        }
      }
    } catch {
      // 路径解析整体失败时保持工具原行为。
    }
    return () => {
      const changes: TrackedKnowledgeChange[] = []
      for (const [target, snapshot] of before) {
        try {
          canonicalPath(target.path)
          const change = createFileChange(
            target.label,
            snapshot,
            readFileChangeSnapshot(canonicalPath(target.path)),
            Date.now(),
          )
          if (change) changes.push(toTrackedChange(change, target.path))
        } catch {
          // 后像不可读时不产生虚假变更。
        }
      }
      if (changes.length === 0) return
      try {
        options.onChanges(changes)
      } catch {
        // 观察者失败不能影响工具结果。
      }
    }
  }

  return {
    classify,
    targets,
    begin,
    async run<T>(
      name: string,
      params: Record<string, unknown>,
      execute: () => Promise<T>,
    ): Promise<T> {
      const finish = begin(name, params)
      try {
        const result = await execute()
        finish()
        return result
      } catch (error) {
        // Shell 失败也可能已产生副作用（例如命令链前半段写入）。
        if (SHELL_TOOLS.has(name)) finish()
        throw error
      }
    },
    runSynchronous<T>(
      name: string,
      params: Record<string, unknown>,
      execute: () => T,
    ): T {
      const finish = begin(name, params)
      try {
        return execute()
      } finally {
        finish()
      }
    },
  }
}
