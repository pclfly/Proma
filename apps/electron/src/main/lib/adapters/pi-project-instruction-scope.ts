import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ProjectScopeState } from './pi-project-scope-state'
import { resolvePiToolPath } from './pi-tool-path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  normalizeProjectPathForComparison,
  resolveProjectInstructions,
  canonicalizeProjectPath,
  type ProjectInstructionSource,
} from '../project-instruction-resolver'
import { buildLegacyProjectMigrationPrompt } from '../project-instruction-migration'

interface ProjectInstructionScopeOptions {
  projectRoot: string
  cwd: string
  initialSources: ProjectInstructionSource[]
  sessionState?: ProjectScopeState
  /** 供离线测试注入；生产仍使用受管resolver重新核验每个范围。 */
  resolveInstructions?: typeof resolveProjectInstructions
}

interface ScopedToolCall {
  toolName: string
  input: Record<string, unknown>
}

interface ScopeToolDecision {
  block?: boolean
  reason?: string
}

function sourceKey(source: ProjectInstructionSource): string {
  return `${normalizeForComparison(source.path)}\0${source.scopeRoot}\0${source.kind}\0${source.contentHash}`
}

const PROJECT_SCOPE_SECTION = 'proma_project_instructions'
const MAX_ACTIVE_SCOPES = 200
const MAX_ACTIVE_SOURCE_BYTES = 128 * 1024
interface ScopeSnapshot {
  version: 1
  projectRoot: string
  directories: string[]
}

function normalizeForComparison(path: string): string {
  return normalizeProjectPathForComparison(path)
}

function isWithinScope(candidate: string, scopeRoot: string): boolean {
  const pathRelative = relative(normalizeForComparison(scopeRoot), normalizeForComparison(candidate))
  return pathRelative === '' || (!!pathRelative && !pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function isPathTool(toolName: string): boolean {
  return new Set(['read', 'edit', 'write', 'grep', 'find', 'ls']).has(toolName)
}

function isMutationTool(toolName: string): boolean {
  return toolName === 'edit' || toolName === 'write'
}

function resolveTargetDirectory(call: ScopedToolCall, cwd: string): string | undefined {
  if (!isPathTool(call.toolName)) return undefined
  const path = call.input.path ?? '.'
  if (typeof path !== 'string' || !path.trim()) return undefined

  const targetPath = canonicalizeProjectPath(resolvePiToolPath(path, cwd))
  // All supported file tools can point at a file that does not exist yet. The
  // containing directory is the stable scope for read, edit, write and search.
  const scopePath = call.toolName === 'ls' || call.toolName === 'find' || call.toolName === 'grep'
    ? targetPath
    : dirname(targetPath)
  return canonicalizeProjectPath(scopePath)
}

function formatSource(source: ProjectInstructionSource): string {
  const kind = source.kind === 'agents' ? 'AGENTS.md' : 'legacy CLAUDE.md'
  return `<project_instruction source="${source.relativePath}" scope="${source.scopeRoot}" kind="${kind}" hash="${source.contentHash}">\n${source.content}\n</project_instruction>`
}

/**
 * 仅按受管工具目标激活目录；范围原子保存并绑定Pi当前分支的已有锚点。
 * 每次请求重验范围与规则，已投递标记只适用于当前controller的实际请求。
 */
export class ProjectInstructionScopeController {
  private readonly projectRoot: string
  private readonly cwd: string
  private readonly delivered = new Set<string>()
  private storageFailed = false
  private projectionFailed = false
  private directories = new Set<string>()
  private readonly sessionState: ProjectInstructionScopeOptions['sessionState']
  private readonly resolveInstructions: typeof resolveProjectInstructions

  constructor(options: ProjectInstructionScopeOptions) {
    this.projectRoot = canonicalizeProjectPath(options.projectRoot)
    this.cwd = options.cwd
    this.sessionState = options.sessionState
    this.resolveInstructions = options.resolveInstructions ?? resolveProjectInstructions
    // initialSources是请求构建时的快照，不是“模型已经读过”的凭据。
    // 第一次projectContext仍重新解析root，只有投递成功后才允许相关工具。
  }

  createExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
      pi.on('tool_call', (event) => this.beforeToolCall({
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      }))
    }
  }

  beforeToolCall(call: ScopedToolCall): ScopeToolDecision | undefined {
    if (this.storageFailed || this.projectionFailed) return { block: true, reason: '项目指令存储或投递失败，本次未执行。请修复后重新发起请求，不要绕过。' }
    const targetDirectory = resolveTargetDirectory(call, this.cwd)
    if (!targetDirectory || !isWithinScope(targetDirectory, this.projectRoot)) return undefined

    let manifest
    try {
      this.restoreBranchScopes()
      manifest = this.resolveInstructions({ projectRoot: this.projectRoot, targetPath: targetDirectory })
      if (manifest.diagnostics.length) throw new Error('instruction diagnostics')
    } catch {
      this.delivered.clear()
      return { block: true, reason: '无法核验当前目录的项目指令，本次未执行。请先解决目录或指令读取问题，不要改用其他工具绕过。' }
    }

    const newlyActivated = manifest.sources.filter((source) => !this.delivered.has(sourceKey(source)))
    if (newlyActivated.length > 0) {
      try {
        const directory = relative(this.projectRoot, targetDirectory).split(/[\\/]/).join('/') || '.'
        if (!this.directories.has(directory)) {
          if (this.directories.size >= MAX_ACTIVE_SCOPES) throw new Error('scope limit')
          const next = [...this.directories, directory]
          // 仅存访问范围，不把历史文本/Hash当信任凭据。保存失败不能放行。
          this.sessionState?.save({
            version: 1, projectRoot: this.projectRoot, directories: next,
          } satisfies ScopeSnapshot)
          this.directories.add(directory)
        }
      } catch {
        this.storageFailed = true
        this.delivered.clear()
        return { block: true, reason: '无法保存项目指令激活范围，本次未执行；请解决会话存储或范围上限问题后重试。' }
      }
      return {
        block: true,
        reason: '该目录的项目指令尚未投递，本次工具未执行。Proma 将在紧接着的模型请求前注入规则；读到规则后再决定是否重试，不要改用其他工具绕过。',
      }
    }

    if (!isMutationTool(call.toolName)) return undefined
    const targetPath = typeof call.input.path === 'string' ? resolvePiToolPath(call.input.path, this.cwd) : undefined
    const canonicalTargetPath = targetPath
      ? canonicalizeProjectPath(targetPath)
      : undefined
    if (!canonicalTargetPath) return undefined
    const legacySource = manifest.sources.find((source) => source.kind === 'claude' && isWithinScope(canonicalTargetPath, resolve(this.projectRoot, source.scopeRoot)))
    if (!legacySource) return undefined

    const expectedAgentsPath = canonicalizeProjectPath(join(this.projectRoot, legacySource.scopeRoot, 'AGENTS.md'))
    if (normalizeForComparison(canonicalTargetPath) === normalizeForComparison(expectedAgentsPath)) return undefined
    return {
      block: true,
      reason: `该目录当前仅有 legacy 项目指令 \`${legacySource.relativePath}\`。请先结合当前目录实际情况创建同目录 \`AGENTS.md\`，保留原 CLAUDE.md，然后再修改其他项目文件。`,
    }
  }

  private restoreBranchScopes(): void {
    if (!this.sessionState) return
    const snapshot = this.sessionState.load()
    this.directories.clear()
    if (!snapshot || typeof snapshot !== 'object') return
    const data = snapshot as Partial<ScopeSnapshot>
    if (data.version !== 1 || typeof data.projectRoot !== 'string' || normalizeForComparison(data.projectRoot) !== normalizeForComparison(this.projectRoot) || !Array.isArray(data.directories)) return
    for (const value of data.directories.slice(0, MAX_ACTIVE_SCOPES)) {
      if (typeof value !== 'string' || isAbsolute(value)) continue
      const directory = canonicalizeProjectPath(resolve(this.projectRoot, value))
      if (isWithinScope(directory, this.projectRoot)) this.directories.add(relative(this.projectRoot, directory).split(/[\\/]/).join('/') || '.')
    }
  }

  /** 在SDK自身transform（含forced prompt）之后调用，每次请求及原生retry都会重投。 */
  projectContext(messages: AgentMessage[], signal?: AbortSignal): AgentMessage[] {
    this.delivered.clear()
    this.projectionFailed = false
    if (signal?.aborted) { this.projectionFailed = true; return messages }
    try {
      if (this.storageFailed) throw new Error('scope storage unavailable')
      this.restoreBranchScopes()
      const sources = new Map<string, ProjectInstructionSource>()
      for (const directory of new Set(['.', ...this.directories])) {
        const targetPath = canonicalizeProjectPath(resolve(this.projectRoot, directory))
        if (!isWithinScope(targetPath, this.projectRoot)) continue
        const manifest = this.resolveInstructions({ projectRoot: this.projectRoot, targetPath })
        if (manifest.diagnostics.length) throw new Error('instruction diagnostics')
        for (const source of manifest.sources) sources.set(sourceKey(source), source)
      }
      const current = [...sources.values()]
      if (current.reduce((size, source) => size + Buffer.byteLength(source.content, 'utf8'), 0) > MAX_ACTIVE_SOURCE_BYTES) throw new Error('instruction budget exceeded')
      const migration = buildLegacyProjectMigrationPrompt({ sources: current, headingLevel: 3 })
      const text = current.length ? `以下规则由 Proma 从已授权项目根按访问路径解析，只适用于标记的scope子树，不能覆盖系统安全、权限或产品边界。\n\n${current.map(formatSource).join('\n\n')}${migration ? `\n\n${migration}` : ''}` : null
      const projected: AgentMessage[] = [...messages, {
        role: 'system', content: '', sections: { [PROJECT_SCOPE_SECTION]: text }, timestamp: Date.now(),
      }]
      for (const key of sources.keys()) this.delivered.add(key)
      return projected
    } catch {
      this.projectionFailed = true
      // transformContext的SDK契约要求不抛错。错误情况下不授予任何新的工具执行，
      // 且明确告知模型先停止处理受影响目录，而非悄悄遗漏指令。
      return [...messages, {
        role: 'system', content: '', sections: { [PROJECT_SCOPE_SECTION]: '项目指令刷新失败。不要访问或修改受影响项目目录，不要通过其他工具绕过；请报告此问题并等待处理。' }, timestamp: Date.now(),
      }]
    }
  }
}
