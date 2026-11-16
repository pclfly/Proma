/**
 * 变更请求观察器
 *
 * 从 Agent 的工具调用与输出里保守地识别 PR 关联线索：
 * - `gh pr view/edit/checkout <url>`：Agent 主动引用了某条 PR
 * - `gh pr create` 的输出：本轮新建的 PR（`url: https://...`）
 * - `git push` 输出里的 `To <remote>` + `branch -> branch`：推送后按分支发现 PR
 *
 * 这里只做文本解析，不访问网络、不执行命令；归属过滤由调用方完成。
 */

import { normalizeChangeRequestUrl } from '@proma/shared'

/** 单次解析的文本上限，避免把整段日志塞进正则。 */
const MAX_TEXT_LENGTH = 512 * 1024

/** 需要跳过下一个 token 的取值型参数。 */
const BODY_VALUE_OPTIONS = new Set([
  '--body', '-b', '--body-file', '-F', '--title', '-t', '--comment', '--notes', '--notes-file',
])

/** 推送输出中识别到的一次分支推送。 */
export interface PushedBranchRef {
  /** 输出里的远端写法（URL 或 `host:owner/repo`）；未识别时为 null。 */
  remote: string | null
  branch: string
}

/** 从任意文本中提取已规范化的 PR 链接（去重、去尾标点）。 */
export function extractChangeRequestUrls(text: string): string[] {
  if (!text || text.length > MAX_TEXT_LENGTH) return []
  const urls: string[] = []
  const pattern = /https?:\/\/[^\s"'<>`)\]]+/gi
  for (const match of text.match(pattern) ?? []) {
    const normalized = normalizeChangeRequestUrl(match.replace(/[.,;:]+$/, ''))
    if (normalized && !urls.includes(normalized)) urls.push(normalized)
  }
  return urls
}

function normalizeCommand(command: string): string {
  return command.replace(/\\\r?\n/g, ' ').trim()
}

/** 是否是 `gh pr create`（允许前缀 cd 与环境变量）。 */
export function isPullRequestCreateCommand(command: string): boolean {
  if (!command) return false
  const normalized = normalizeCommand(command)
  if (!/\bgh\b/.test(normalized)) return false
  return /(^|[;&|]\s*)(?:cd\s+[^;&|]+?[;&|]\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/.test(normalized)
}

/** 是否是读取/切换 PR 的命令（其结果里的 url 属于本轮引用的 PR）。 */
export function isPullRequestReferenceCommand(command: string): boolean {
  if (!command) return false
  return /\bgh\s+pr\s+(?:view|edit|checkout)\b/.test(normalizeCommand(command))
}

/** 是否是 `git push`（允许 -C/--flag 前缀）。 */
export function isPushCommand(command: string): boolean {
  if (!command) return false
  return /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/.test(normalizeCommand(command))
}

/** 仅保留命令里显式写出的 PR 链接，忽略 --body 等取值。 */
export function selectedChangeRequestUrls(command: string): string[] {
  if (!isPullRequestReferenceCommand(command)) return []
  const stripped = normalizeCommand(command).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
  const urls: string[] = []
  let skipNext = false
  for (const token of stripped.split(/\s+/)) {
    if (!token) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (BODY_VALUE_OPTIONS.has(token)) {
      skipNext = true
      continue
    }
    const normalized = normalizeChangeRequestUrl(token.replace(/[.,;:]+$/, ''))
    if (normalized && !urls.includes(normalized)) urls.push(normalized)
  }
  return urls
}

/** 从 `gh pr view/create` 输出里取"这一条"PR 的链接，避免误收其它链接。 */
export function ownChangeRequestUrlFromOutput(text: string): string | null {
  if (!text || text.length > MAX_TEXT_LENGTH) return null
  const candidates: string[] = []
  for (const match of text.matchAll(/^\s*url:\s*(\S+)\s*$/gim)) candidates.push(match[1] ?? '')
  for (const match of text.matchAll(/"url"\s*:\s*"([^"]+)"/g)) candidates.push(match[1] ?? '')
  for (const candidate of candidates) {
    const normalized = normalizeChangeRequestUrl(candidate.replace(/[.,;:]+$/, ''))
    if (normalized) return normalized
  }
  return null
}

/**
 * 解析 `git push` 输出里的分支推送。
 *
 * 只看 `To <remote>` 之后的 `->` 行；tag、删除、非 heads 引用一律忽略。
 */
export function pushedBranchesFromOutput(text: string): PushedBranchRef[] {
  if (!text || text.length > MAX_TEXT_LENGTH) return []
  const pushed: PushedBranchRef[] = []
  let remote: string | null = null

  for (const line of text.split(/\r?\n/)) {
    const target = /^To (\S+)$/.exec(line.trim())
    if (target) {
      remote = target[1] ?? null
      continue
    }
    if (remote === null) continue

    const updated = /^\s*[+\-*! ]*\s*(.+?)\s*->\s*(\S+)\s*(?:\(forced update\))?$/.exec(line)
    if (!updated) continue
    const left = updated[1]
    const destination = updated[2]
    if (!left || !destination) continue
    if (/\[new tag\]|\[tag update\]|\[deleted\]/.test(left)) continue

    const source = left.split(/\s+/).pop() ?? ''
    if (source.startsWith('refs/tags/') || destination.startsWith('refs/tags/')) continue
    if (destination.startsWith('refs/') && !destination.startsWith('refs/heads/')) continue

    const branch = destination.replace(/^refs\/heads\//, '')
    if (!branch || branch === 'HEAD' || branch.startsWith('refs/')) continue
    if (pushed.some((entry) => entry.remote === remote && entry.branch === branch)) continue
    pushed.push({ remote, branch })
  }
  return pushed
}

/** 内置 Shell 工具名（不同 runtime 的叫法）。 */
export function isShellToolName(name: string): boolean {
  const value = name.toLowerCase()
  return value === 'bash' || value === 'shell' || value === 'terminalexecute' || value === 'run_command'
}

/** 从工具入参里取命令字符串；没有命令时 null。 */
export function commandFromToolInput(input: Record<string, unknown> | undefined): string | null {
  const command = input?.command
  return typeof command === 'string' && command.trim() ? command : null
}

/** 取出 tool_result 的文本内容（字符串或内容块数组）。 */
export function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block) {
        const text = (block as Record<string, unknown>).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * tool_use → 命令的内存索引。
 *
 * tool_result 只携带 tool_use_id，必须靠它把结果对回命令；上限防止长会话无限增长。
 */
export class PendingCommandTracker {
  private readonly commands = new Map<string, string>()

  constructor(private readonly limit = 200) {}

  remember(toolUseId: string, command: string): void {
    this.commands.set(toolUseId, command)
    while (this.commands.size > this.limit) {
      const oldest = this.commands.keys().next().value
      if (oldest === undefined) break
      this.commands.delete(oldest)
    }
  }

  take(toolUseId: string): string | null {
    const command = this.commands.get(toolUseId) ?? null
    this.commands.delete(toolUseId)
    return command
  }

  clear(): void {
    this.commands.clear()
  }

  get size(): number {
    return this.commands.size
  }
}
