import { createHash } from 'node:crypto'
import { findLatestExplicitUserIndex } from './agent-context-boundary'

/** 接受Pi原生消息与测试夹具；只投影content，不解释或执行其中指令。 */
export interface ContextMessage {
  role?: unknown
  content?: unknown
  toolName?: unknown
  toolCallId?: unknown
  isError?: unknown
}

interface ContextLimits {
  maxActiveChars: number
  maxSingleChars: number
  historicalPreviewChars: number
  maxArgumentChars: number
}

export interface ContextProjectionStats {
  inputMaterialChars: number
  outputMaterialChars: number
  activeChars: number
  referencedMaterials: number
  shortenedArguments: number
}

interface ContextPolicyOptions {
  limits?: Partial<ContextLimits>
  internalUserPrompt?: string
  /** 必须返回当前原生分支中经过显式context_edit的消息，包括压缩前原文。 */
  getSourceMessages?: () => readonly ContextMessage[]
}

export interface ContextSourceRange { startMessage?: number; endMessage?: number }
interface ContextSourceRangeInfo { startMessage: number; endMessage: number; totalMessages: number }
export interface ContextReadOptions extends ContextSourceRange { offset?: number; limit?: number }
export interface ContextReadResult { reference: string; text: string; offset: number; totalChars: number; nextOffset: number | null; sourceRange: ContextSourceRangeInfo }
export interface ContextIndexOptions extends ContextSourceRange { cursor?: number; maxItems?: number }
export interface ContextIndexResult {
  materials: Array<{ reference: string; source: string; sourceMessage: number; totalChars: number; matchOffset: number | null }>
  totalMatches: number
  nextCursor: number | null
  sourceRange: ContextSourceRangeInfo
}

interface Material {
  messageIndex: number
  blockIndex: number
  text: string
  kind: 'quote' | 'result'
  label: string
  resource: boolean
  start?: number
  end?: number
}

const DEFAULT_LIMITS: ContextLimits = {
  maxActiveChars: 32_000,
  maxSingleChars: 12_000,
  historicalPreviewChars: 180,
  maxArgumentChars: 1600,
}
export const MAX_CONTEXT_READ_CHARS = 8_000
const REFERENCE_PATTERN = /^ctx_[a-f0-9]{64}$/
const SHORT_RESULT_CHARS = 768
const MAX_ARGUMENT_DEPTH = 16
// 线性工作量上限；超过时明确失败，不退回发送未投影原文。
const MAX_SCAN_CHARS = 64_000_000
const MAX_MATERIALS = 16_384
const ARGUMENT_KEYS = new Set(['content', 'command', 'oldText', 'newText', 'old_string', 'new_string', 'code', 'script', 'text', 'prompt', 'description'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('上下文读取或投影已取消', 'AbortError')
}
function textParts(message: ContextMessage): Array<{ blockIndex: number; text: string }> {
  if (typeof message.content === 'string') return [{ blockIndex: -1, text: message.content }]
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((block: unknown, blockIndex: number) => {
    const value = record(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [{ blockIndex, text: value.text }] : []
  })
}
function contextReference(text: string): string {
  return `ctx_${createHash('sha256').update(text, 'utf8').digest('hex')}`
}
function isResourceTool(name: string): boolean {
  return /(?:^|__)(?:read|readcontext|read_context|grep|find|ls|browserextract|browserobserve|browserfind)$/i.test(name)
}
function toolCalls(messages: readonly ContextMessage[]): Map<string, { name: string; args: Record<string, unknown> }> {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const value = record(block)
      if (value?.type === 'toolCall' && typeof value.id === 'string' && typeof value.name === 'string') {
        calls.set(value.id, { name: value.name, args: record(value.arguments) ?? {} })
      }
    }
  }
  return calls
}
function materials(messages: readonly ContextMessage[], signal?: AbortSignal): Material[] {
  const found: Material[] = []
  const calls = toolCalls(messages)
  let scannedChars = 0
  const add = (item: Material): void => {
    if (found.length >= MAX_MATERIALS) throw new Error('上下文材料数量超过准备上限，请缩小会话片段。')
    found.push(item)
  }
  const scan = (text: string): void => {
    scannedChars += text.length
    if (scannedChars > MAX_SCAN_CHARS) throw new Error('上下文材料超过64M字符准备上限，请按会话区间或源路径读取。')
  }
  messages.forEach((message, messageIndex) => {
    checkAbort(signal)
    if (message.role === 'user') {
      for (const part of textParts(message)) {
        scan(part.text)
        // 单向扫描。首个开标记之后找不到闭标记时立即结束，不对后续每个起点重扫全文。
        let cursor = 0
        while (cursor < part.text.length) {
          checkAbort(signal)
          const open = part.text.indexOf('<quoted_file', cursor)
          if (open < 0) break
          const boundary = part.text[open + 12]
          cursor = open + 12
          if (boundary !== '>' && boundary !== undefined && !/\s/.test(boundary)) continue
          const openEnd = part.text.indexOf('>', cursor)
          if (openEnd < 0) break
          const close = part.text.indexOf('</quoted_file>', openEnd + 1)
          if (close < 0) break
          const start = openEnd + 1
          add({ messageIndex, blockIndex: part.blockIndex, text: part.text.slice(start, close), kind: 'quote', resource: true,
            label: part.text.slice(open, openEnd + 1).match(/\bpath="([^"]*)"/)?.[1] ?? '文件选区', start, end: close })
          cursor = close + 14
        }
      }
    } else if (message.role === 'toolResult') {
      const call = typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined
      const name = typeof message.toolName === 'string' ? message.toolName : call?.name ?? 'tool'
      const path = call?.args.path ?? call?.args.file_path
      for (const part of textParts(message)) {
        scan(part.text)
        add({ messageIndex, blockIndex: part.blockIndex, text: part.text, kind: 'result', resource: isResourceTool(name),
          label: `${name}${typeof path === 'string' ? ` ${path.slice(0, 240)}` : ''}` })
      }
    }
  })
  return found
}

/** 仅遍历文件内容/脚本/编辑锚点字段；保留参数的对象、数组、路径和类型。 */
function mapArgumentStrings(value: unknown, map: (text: string) => string, depth = 0, key = ''): unknown {
  if (typeof value === 'string') {
    if (!ARGUMENT_KEYS.has(key)) return value
    if (value.length > MAX_SCAN_CHARS) throw new Error('工具参数超过上下文准备上限，请按源路径或会话区间读取。')
    return map(value)
  }
  if (depth >= MAX_ARGUMENT_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => { const mapped = mapArgumentStrings(item, map, depth + 1, key); changed ||= mapped !== item; return mapped })
    return changed ? next : value
  }
  const object = record(value)
  if (!object) return value
  let changed = false
  const entries = Object.entries(object).map(([field, item]) => {
    const mapped = mapArgumentStrings(item, map, depth + 1, field)
    changed ||= mapped !== item
    return [field, mapped] as const
  })
  // fromEntries保留__proto__等JSON键为数据属性，不触发对象原型setter。
  return changed ? Object.fromEntries(entries) : value
}

function note(text: string, label: string, previewChars: number, historical: boolean): string {
  const reference = contextReference(text)
  const preview = text.slice(0, previewChars)
  return `[${historical ? '历史材料未发送' : '材料仅发送节选'}；${label.slice(0, 280)}；原文${text.length}字符；引用${reference}。需原文用ReadContext，不要重跑已完成工具。]${preview ? `\n[原文节选0–${preview.length}，非全文]\n${preview}` : ''}`
}

/** 请求投影不落盘、不重跑工具；ReadContext从当前分支原始快照按需恢复。 */
export function createAgentContextRequestPolicy(options: ContextPolicyOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const key of Object.keys(limits) as Array<keyof ContextLimits>) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0) limits[key] = DEFAULT_LIMITS[key]
    limits[key] = Math.floor(limits[key])
  }
  let lastSource: readonly ContextMessage[] = []
  let lastStats: ContextProjectionStats = { inputMaterialChars: 0, outputMaterialChars: 0, activeChars: 0, referencedMaterials: 0, shortenedArguments: 0 }

  function selectSource(input: ContextSourceRange) {
    const all = options.getSourceMessages?.() ?? lastSource
    const startMessage = input.startMessage ?? 0, endMessage = input.endMessage ?? all.length
    if (!Number.isSafeInteger(startMessage) || !Number.isSafeInteger(endMessage) || startMessage < 0 || endMessage < startMessage || endMessage > all.length) {
      throw new Error(`startMessage/endMessage必须限定当前原始分支的0–${all.length}消息范围，左闭右开。`)
    }
    return { source: startMessage === 0 && endMessage === all.length ? all : all.slice(startMessage, endMessage),
      range: { startMessage, endMessage, totalMessages: all.length } }
  }

  function sourceMaterials(selected: ReturnType<typeof selectSource>, signal?: AbortSignal): Material[] {
    try { return materials(selected.source, signal) } catch (error) {
      checkAbort(signal)
      throw new Error(`材料查询准备失败或超过上限。请用ReadContext的startMessage/endMessage分段查询原始分支（0–${selected.range.totalMessages}消息），不要反复压缩；单个超大材料请按源文件路径读取。`, { cause: error })
    }
  }

  function project<T extends ContextMessage>(messages: T[], signal?: AbortSignal, allHistorical = false): T[] {
    checkAbort(signal)
    lastSource = messages
    const latestUser = allHistorical ? messages.length : findLatestExplicitUserIndex(messages, options.internalUserPrompt)
    const candidates = materials(messages, signal)
    const output = new Map<Material, string>()
    const stats: ContextProjectionStats = { inputMaterialChars: 0, outputMaterialChars: 0, activeChars: 0, referencedMaterials: 0, shortenedArguments: 0 }
    let remaining = limits.maxActiveChars
    const currentResults = candidates.filter((item) => item.kind === 'result' && item.messageIndex >= latestUser).reverse()
    // 给最新工具证据预留机会，防止当前大文件选区占满后ReadContext永远取不回正文。
    const reserve = Math.min(Math.floor(remaining / 3), currentResults.reduce((sum, item) => sum + Math.min(item.text.length, limits.maxSingleChars), 0))
    const currentQuotes = candidates.filter((item) => item.kind === 'quote' && item.messageIndex >= latestUser)
    const ordered = [...currentQuotes, ...currentResults, ...candidates.filter((item) => item.messageIndex < latestUser)]
    for (const item of ordered) {
      checkAbort(signal)
      stats.inputMaterialChars += item.text.length
      const historical = item.messageIndex < latestUser
      // 短状态/错误继续保留事实；文件正文即使短，也不隐式跨任务激活。
      const shortState = item.kind === 'result' && !item.resource && item.text.length <= SHORT_RESULT_CHARS
      let projected: string
      if (shortState) projected = item.text
      else {
        const allowance = historical ? 0 : Math.min(limits.maxSingleChars, Math.max(0, remaining - (item.kind === 'quote' ? reserve : 0)))
        const retained = Math.min(item.text.length, allowance)
        if (retained === item.text.length && !historical) projected = item.text
        else {
          const preview = historical ? item.resource ? 0 : Math.min(limits.historicalPreviewChars, item.text.length) : retained
          projected = note(item.text, item.label, preview, historical)
          stats.referencedMaterials++
        }
        if (!historical) { remaining -= retained; stats.activeChars += retained }
      }
      output.set(item, projected)
      stats.outputMaterialChars += projected.length
    }

    // 延迟复制消息与内容块，保留所有身份字段和toolCall/result关系。
    const projected = [...messages]
    const changes = new Map<string, Material[]>()
    for (const item of candidates) {
      if (output.get(item) === item.text) continue
      const key = `${item.messageIndex}:${item.blockIndex}`
      const list = changes.get(key) ?? []
      list.push(item); changes.set(key, list)
    }
    for (const list of changes.values()) {
      const first = list[0]!
      const original = messages[first.messageIndex]!
      const part = textParts(original).find((candidate) => candidate.blockIndex === first.blockIndex)!
      let next: string
      if (first.kind === 'result') next = output.get(first)!
      else {
        const fragments: string[] = []
        let cursor = 0
        for (const item of list.sort((a, b) => a.start! - b.start!)) {
          fragments.push(part.text.slice(cursor, item.start), output.get(item)!)
          cursor = item.end!
        }
        fragments.push(part.text.slice(cursor))
        next = fragments.join('')
      }
      const current = projected[first.messageIndex]!
      if (first.blockIndex === -1) projected[first.messageIndex] = { ...current, content: next }
      else {
        const content = [...current.content as unknown[]]
        content[first.blockIndex] = { ...record(content[first.blockIndex]), text: next }
        projected[first.messageIndex] = { ...current, content }
      }
    }

    const completed = new Set(messages.flatMap((message) => message.role === 'toolResult' && typeof message.toolCallId === 'string' ? [message.toolCallId] : []))
    // 长参数不应因一次用户任务有许多成功工具回合而无限累积。
    let argumentBudget = Math.min(8_000, limits.maxActiveChars)
    for (let index = messages.length - 1; index >= 0; index--) {
      checkAbort(signal)
      const message = projected[index]!
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      let changed = false
      const content = message.content.map((block: unknown) => {
        const value = record(block)
        if (value?.type !== 'toolCall' || typeof value.id !== 'string' || (!allHistorical && !completed.has(value.id))) return block
        const args = mapArgumentStrings(value.arguments, (source) => {
          stats.inputMaterialChars += source.length
          if (stats.inputMaterialChars > MAX_SCAN_CHARS) throw new Error('上下文材料超过准备上限，请缩小源会话片段。')
          const maxChars = index < latestUser ? limits.historicalPreviewChars : Math.min(argumentBudget, limits.maxArgumentChars)
          if (source.length <= maxChars) { if (index >= latestUser) argumentBudget -= source.length; stats.outputMaterialChars += source.length; return source }
          const preview = Math.min(maxChars, source.length)
          const replacement = note(source, `${allHistorical ? '历史' : '已执行'}工具参数（节选不是可执行输入）`, preview, index < latestUser)
          if (index >= latestUser) argumentBudget -= preview
          stats.outputMaterialChars += replacement.length
          stats.shortenedArguments++; stats.referencedMaterials++
          return replacement
        })
        if (args === value.arguments) return block
        changed = true
        return { ...value, arguments: args }
      })
      if (changed) projected[index] = { ...message, content }
    }
    lastStats = stats
    return projected
  }

  function read(reference: string, input: ContextReadOptions = {}, signal?: AbortSignal): ContextReadResult {
    checkAbort(signal)
    if (!REFERENCE_PATTERN.test(reference)) throw new Error('无效上下文引用；不能用路径读取文件。')
    const offset = input.offset ?? 0, limit = input.limit ?? 4000
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTEXT_READ_CHARS) {
      throw new Error(`offset必须是非负整数，limit必须为1–${MAX_CONTEXT_READ_CHARS}。`)
    }
    // 每次从当前分支验证，不保留可跨rewind/context_edit的原文授权缓存。
    const selected = selectSource(input), source = selected.source
    let found: string | undefined
    for (const item of sourceMaterials(selected, signal)) {
      checkAbort(signal)
      if (contextReference(item.text) === reference) { found = item.text; break }
    }
    if (found === undefined) {
      let argumentChars = 0
      for (const message of source) {
        checkAbort(signal)
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
        for (const block of message.content) {
          const value = record(block)
          if (value?.type !== 'toolCall') continue
          mapArgumentStrings(value.arguments, (text) => {
            argumentChars += text.length
            if (argumentChars > MAX_SCAN_CHARS) throw new Error('原文参数查找超过准备上限，请按源会话区间读取。')
            if (contextReference(text) === reference) found = text
            return text
          })
          if (found !== undefined) break
        }
        if (found !== undefined) break
      }
    }
    if (found === undefined) throw new Error('当前分支没有此原文引用；可能已回退或被显式移除，请按保留的源路径重新读取，不要重跑副作用工具。')
    if (offset > found.length) throw new Error(`offset超出原文长度${found.length}。`)
    const end = Math.min(found.length, offset + limit)
    return { reference, text: found.slice(offset, end), offset, totalChars: found.length, nextOffset: end < found.length ? end : null, sourceRange: selected.range }
  }

  function list(query = '', input: ContextIndexOptions = {}, signal?: AbortSignal): ContextIndexResult {
    checkAbort(signal)
    const cursor = input.cursor ?? 0, maxItems = input.maxItems ?? 10
    if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10) throw new Error('索引query最多200字符，cursor为非负整数，maxItems为1–10。')
    const selected = selectSource(input), source = selected.source
    const snapshots: Array<{ text: string; label: string; sourceMessage: number }> = []
    for (const item of sourceMaterials(selected, signal)) {
      const name = source[item.messageIndex]?.toolName
      // 索引不递归列出自身结果；原始材料始终能独立发现。
      if (name === 'ReadContext' || !item.text || (item.kind === 'result' && !item.resource && item.text.length <= SHORT_RESULT_CHARS)) continue
      snapshots.push({ text: item.text, label: item.label, sourceMessage: selected.range.startMessage + item.messageIndex })
    }
    for (const [messageIndex, message] of source.entries()) {
      checkAbort(signal)
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        const value = record(block)
        if (value?.type !== 'toolCall') continue
        const args = record(value.arguments)
        const path = args?.path ?? args?.file_path
        mapArgumentStrings(args, (text) => {
          if (text.length > limits.historicalPreviewChars) snapshots.push({ text, label: `${String(value.name)} 工具参数快照${typeof path === 'string' ? ` ${path.slice(0, 160)}` : ''}`, sourceMessage: selected.range.startMessage + messageIndex })
          return text
        })
      }
    }
    let sourceChars = 0
    const matches: Array<{ text: string; label: string; sourceMessage: number; matchOffset: number | null }> = []
    for (const item of snapshots) {
      checkAbort(signal)
      sourceChars += item.text.length
      if (sourceChars > MAX_SCAN_CHARS || matches.length > MAX_MATERIALS) throw new Error('上下文索引超过准备上限，请使用更小的源会话区间。')
      const matchOffset = query ? item.text.indexOf(query) : -1
      if (!query || item.label.includes(query) || matchOffset >= 0) matches.push({ ...item, matchOffset: matchOffset >= 0 ? matchOffset : null })
    }
    const page = matches.slice(cursor, cursor + maxItems)
    return { materials: page.map((item) => ({ reference: contextReference(item.text), source: item.label.slice(0, 200), sourceMessage: item.sourceMessage, totalChars: item.text.length, matchOffset: item.matchOffset })),
      totalMatches: matches.length, nextCursor: cursor + page.length < matches.length ? cursor + page.length : null, sourceRange: selected.range }
  }

  return { project, read, list,
    projectForSummary: <T extends ContextMessage>(messages: T[], signal?: AbortSignal): T[] => project(messages, signal, true),
    getLastProjectionStats: () => ({ ...lastStats }),
  }
}
export type AgentContextRequestPolicy = ReturnType<typeof createAgentContextRequestPolicy>
