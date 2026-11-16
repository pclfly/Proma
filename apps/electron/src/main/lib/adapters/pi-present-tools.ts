/**
 * Pi 交付物声明工具。
 *
 * 官方 0.22.28：每轮结束时由 Agent 单独声明最终成品，用户在交付物卡上点击即可
 * 打开预览或系统应用。本工具只做路径安全校验与去重，不复制、不修改、不移动文件；
 * 真正的展示与打开动作由调用方（渲染进程 / IPC）负责。
 *
 * 安全边界：
 * - 相对路径按 `agentCwd` 解析，`~` 按当前用户目录展开后仍须通过授权校验；
 * - realpath 之后必须位于 `agentCwd` 或 `allowedRoots` 内，链接指向外部即拒绝；
 * - 必须是普通文件，目录、设备、管道、链接自身一律拒绝；
 * - 单次最多声明 8 个交付物，重复路径按 realpath 去重。
 */

import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { resolvePathAgainstAgentCwd } from '../agent-file-path'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 单次可声明的交付物上限。 */
export const MAX_PRESENT_FILES = 8

/** 交付物描述的最大长度，避免把整段总结塞进卡片。 */
const MAX_PRESENT_DESCRIPTION_LENGTH = 500

export interface PresentToolsContext {
  /** 当前 Agent 会话的工作目录，相对路径以此为基准 */
  agentCwd: string
  /** 额外授权根目录（附加目录等），与 agentCwd 一起构成允许范围 */
  allowedRoots?: readonly string[]
}

export interface PresentFileDeclaration {
  /** realpath 之后的绝对路径，可直接交给预览或系统打开 */
  path: string
  /** 文件名（不含目录） */
  name: string
  /** Agent 对该交付物的简短说明 */
  description?: string
}

export interface PresentToolResult {
  files: PresentFileDeclaration[]
}

/** 判断 target 是否位于 root 之内（含 root 本身）。 */
function isPathWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

/**
 * 把授权根目录规范化为 realpath。
 *
 * 不存在的根直接忽略：附加目录可能在会话期间被移除，但不能因此放行任何路径。
 * agentCwd 本身不可用时没有可用范围，后续校验会统一拒绝。
 */
function resolveAuthorizedRoots(ctx: PresentToolsContext): string[] {
  const roots: string[] = []
  const candidates = [ctx.agentCwd, ...(ctx.allowedRoots ?? [])]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.includes('\0')) continue
    try {
      const canonicalPath = realpathSync(resolve(candidate))
      if (statSync(canonicalPath).isDirectory()) roots.push(canonicalPath)
    } catch {
      // 根目录不存在或不可访问：跳过，不扩大授权范围。
    }
  }
  return roots
}

function readPresentEntries(params: unknown): unknown[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Present 需要一个包含 files 数组的参数对象')
  }
  const rawFiles = (params as { files?: unknown }).files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('至少声明 1 个交付物文件')
  }
  if (rawFiles.length > MAX_PRESENT_FILES) {
    throw new Error(`单次最多声明 ${MAX_PRESENT_FILES} 个交付物文件`)
  }
  return rawFiles
}

function readDescription(value: unknown, displayPath: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`交付物描述必须是字符串: ${displayPath}`)
  }
  const description = value.trim()
  if (description.length > MAX_PRESENT_DESCRIPTION_LENGTH) {
    throw new Error(`交付物描述超过 ${MAX_PRESENT_DESCRIPTION_LENGTH} 个字符: ${displayPath}`)
  }
  return description === '' ? undefined : description
}

function resolvePresentFile(entry: unknown, ctx: PresentToolsContext, roots: string[]): PresentFileDeclaration {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('files 中的每一项都必须是 { path, description? } 对象')
  }
  const record = entry as { path?: unknown; description?: unknown }
  if (typeof record.path !== 'string') {
    throw new Error('交付物路径必须是字符串')
  }
  const requestedPath = record.path.trim()
  if (requestedPath === '') {
    throw new Error('交付物路径不能为空')
  }
  if (requestedPath.includes('\0')) {
    throw new Error('交付物路径包含非法字符')
  }

  const resolvedPath = resolvePathAgainstAgentCwd(requestedPath, ctx.agentCwd)
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(resolvedPath)
  } catch {
    throw new Error(`交付物文件不存在或无法访问: ${requestedPath}`)
  }

  if (roots.length === 0) {
    throw new Error('当前会话没有可用的授权目录，无法声明交付物')
  }
  if (!roots.some((root) => isPathWithin(root, canonicalPath))) {
    throw new Error(`交付物路径超出授权目录: ${requestedPath}`)
  }

  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(canonicalPath)
  } catch {
    throw new Error(`交付物文件不存在或无法访问: ${requestedPath}`)
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`交付物不是普通文件: ${requestedPath}`)
  }

  const description = readDescription(record.description, requestedPath)
  return description === undefined
    ? { path: canonicalPath, name: basename(canonicalPath) }
    : { path: canonicalPath, name: basename(canonicalPath), description }
}

/** 校验并规范化交付物声明；不读写文件内容。 */
function collectPresentFiles(params: unknown, ctx: PresentToolsContext): PresentToolResult {
  const roots = resolveAuthorizedRoots(ctx)
  if (roots.length === 0) {
    throw new Error('当前会话没有可用的授权目录，无法声明交付物')
  }

  const files: PresentFileDeclaration[] = []
  const seen = new Set<string>()
  for (const entry of readPresentEntries(params)) {
    const file = resolvePresentFile(entry, ctx, roots)
    // Windows 路径大小写不敏感，去重键与文件系统保持一致。
    const dedupeKey = process.platform === 'win32' ? file.path.toLowerCase() : file.path
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    files.push(file)
  }
  return { files }
}

export function buildPresentTools(sdk: PiSdk, ctx: PresentToolsContext): ToolDefinition[] {
  return [
    sdk.defineTool({
      name: 'Present',
      label: '声明交付物',
      description:
        'Declare the final deliverable files produced in this turn so the user can open them directly. '
        + 'Each path must resolve (after realpath) to a regular file inside the agent working directory or an allowed root; '
        + 'directories, symlinks escaping those roots, missing files and empty paths are rejected. '
        + 'Accepts at most 8 unique files per call, resolves relative paths against the agent working directory, '
        + 'and does not copy, modify or move anything.',
      promptSnippet:
        'At the end of a turn that produced user-facing artifacts, call Present once with the final files only. '
        + 'Do not declare scratch files, dependencies, directories or files outside the workspace.',
      parameters: Type.Object({
        files: Type.Array(
          Type.Object({
            path: Type.String({
              minLength: 1,
              maxLength: 4096,
              description: 'Absolute path, or a path relative to the agent working directory.',
            }),
            description: Type.Optional(Type.String({
              maxLength: MAX_PRESENT_DESCRIPTION_LENGTH,
              description: 'One short line describing this deliverable.',
            })),
          }, { additionalProperties: false }),
          { minItems: 1, maxItems: MAX_PRESENT_FILES },
        ),
      }, { additionalProperties: false }),
      async execute(_toolCallId: string, params: unknown) {
        const result = collectPresentFiles(params, ctx)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
        }
      },
    }),
  ]
}
