/**
 * 流式增量语法高亮
 *
 * 聊天代码块在逐 token 输出时，code 字符串每帧都会变长。若每帧全量 token 化，
 * 长代码块的渲染成本会随长度线性增长；本模块在「新代码以旧代码为前缀」的
 * 流式前提下复用已完成行的 token，只重新高亮末尾未完成行与新增内容。
 *
 * 正确性边界（重要）：
 * - 已完成行（以 '\n' 结尾的行）的 token 只取决于该行起始处的语法状态，
 *   而旧代码是新代码的前缀、前半段内容未变，因此复用这些行是安全的。
 * - 末尾未完成行始终重新高亮：若它处在跨行字符串/注释/模板字符串中，
 *   独立高亮的结果可能与全量结果颜色不同。这是有意接受的代价，且只影响
 *   当前这一行；一旦该行被换行结束，stateful 语言会退回全量重算，
 *   不会把可能带偏差的 token 冻结成「已完成行」。
 * - 编辑既有行、语言/主题变化都会使前缀判断或缓存键失效，走全量重算。
 *
 * 缓存有界：按「语言 + 主题」保存最近一次结果，并限制单条代码长度、
 * 条目数与缓存总字符数，避免长会话里内存无上限增长。
 */

import { highlightToTokens } from './shiki-service.ts'
import type { HighlightOptions, HighlightTokensResult } from './shiki-service.ts'

/** 高亮函数签名：与 highlightToTokens 一致，可注入以便测试或替换实现 */
export type HighlightTokenizeFn = (options: HighlightOptions) => HighlightTokensResult | null

/** 默认主题，与 shiki-service 的默认值保持一致 */
const DEFAULT_THEME = 'github-dark'

/** 缓存默认上限：条目数 / 单条代码长度 / 缓存总字符数 */
const DEFAULT_MAX_ENTRIES = 6
const DEFAULT_MAX_CODE_LENGTH = 100_000
const DEFAULT_MAX_TOTAL_CODE_LENGTH = 400_000

/**
 * 行内语法完全独立的语言：任意追加都可以复用完整行
 * 其余语言（含未知语言）一律按 stateful 保守处理。
 */
const STATELESS_LANGUAGES: ReadonlySet<string> = new Set([
  'text', 'txt', 'plaintext', 'plain', 'diff', 'log',
])

/** 创建一个流式高亮缓存的选项 */
export interface StreamingHighlightCacheOptions {
  /** 注入的高亮函数，默认使用 highlightToTokens */
  tokenize?: HighlightTokenizeFn
  /** 最多保留多少个语言/主题条目，默认 6 */
  maxEntries?: number
  /** 单条代码超过该长度时不写入缓存，默认 100000 */
  maxCodeLength?: number
  /** 缓存内代码字符总数上限，默认 400000 */
  maxTotalCodeLength?: number
}

/** 流式高亮缓存句柄（内部状态放在 WeakMap 中，避免暴露可变结构） */
export interface StreamingHighlightCache {
  /** 当前缓存的条目数（用于内存观测与测试） */
  readonly size: number
  /** 清空全部缓存：切换语言/主题或需要强制失效时调用 */
  clear(): void
}

/** 单条缓存记录 */
interface StreamingCacheEntry {
  code: string
  language: string
  theme: string
  result: HighlightTokensResult
}

/** 缓存内部状态 */
interface StreamingCacheState {
  entries: Map<string, StreamingCacheEntry>
  tokenize: HighlightTokenizeFn
  maxEntries: number
  maxCodeLength: number
  maxTotalCodeLength: number
}

/** 缓存句柄 → 内部状态 */
const CACHE_STATES = new WeakMap<StreamingHighlightCache, StreamingCacheState>()

/** 语言名归一化：去空白、小写，空值按 text 处理 */
function normalizeLanguage(language: string): string {
  const key = language.trim().toLowerCase()
  return key || 'text'
}

/** 语言是否带有跨行语法状态（未知语言按 stateful 保守处理） */
export function isStatefulLanguage(language: string): boolean {
  return !STATELESS_LANGUAGES.has(normalizeLanguage(language))
}

/** 统计换行数，等价于「完整行数」 */
function countNewlines(code: string): number {
  let count = 0
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10) count += 1
  }
  return count
}

/**
 * 判断能否安全复用旧结果中已完成行的 token
 *
 * 前置条件：调用方已通过缓存键确认语言/主题未变；本函数只判断代码维度。
 * 规则：
 * - 非追加式变更（编辑既有行、回退）→ 不可复用；
 * - stateless 语言 → 任意追加都可复用完整行；
 * - stateful 语言 → 仅当「本次追加不含换行」且「旧代码存在完整行」时可复用。
 *   追加含换行会把独立高亮的未完成行冻结为完整行，必须全量重算纠正；
 *   旧代码没有任何完整行时无可复用内容，等同于全量重算。
 *
 * @param theme 当前主题。主题只影响颜色、不影响行级语法状态，是否换主题由
 *              缓存键负责失效；保留该参数使调用方与缓存共用同一份上下文。
 */
export function canReuseStreamingTokens(
  prevCode: string,
  nextCode: string,
  language: string,
  theme: string | undefined,
): boolean {
  // 主题只影响颜色，是否切换由缓存键失效；显式忽略以免未使用参数告警
  void theme

  if (prevCode === nextCode) return true
  if (prevCode.length === 0) return false
  if (!nextCode.startsWith(prevCode)) return false

  const appended = nextCode.slice(prevCode.length)

  if (isStatefulLanguage(language)) {
    if (appended.includes('\n')) return false
    if (!prevCode.includes('\n')) return false
  }
  return true
}

/**
 * 创建流式高亮缓存
 *
 * 同一个缓存实例可以在多个代码块之间共享：条目按「语言 + 主题」隔离，
 * 只有新代码以某条旧代码为前缀时才会命中。
 */
export function createStreamingHighlightCache(
  options: StreamingHighlightCacheOptions = {},
): StreamingHighlightCache {
  const state: StreamingCacheState = {
    entries: new Map(),
    tokenize: options.tokenize ?? highlightToTokens,
    maxEntries: Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    maxCodeLength: Math.max(0, options.maxCodeLength ?? DEFAULT_MAX_CODE_LENGTH),
    maxTotalCodeLength: Math.max(0, options.maxTotalCodeLength ?? DEFAULT_MAX_TOTAL_CODE_LENGTH),
  }

  const cache: StreamingHighlightCache = {
    get size() {
      return state.entries.size
    },
    clear() {
      state.entries.clear()
    },
  }

  CACHE_STATES.set(cache, state)
  return cache
}

/** 取缓存内部状态，非法句柄直接报错（属于调用方编程错误） */
function getCacheState(cache: StreamingHighlightCache): StreamingCacheState {
  const state = CACHE_STATES.get(cache)
  if (!state) {
    throw new Error('[streaming-highlight] 缓存句柄无效，请使用 createStreamingHighlightCache() 创建')
  }
  return state
}

/** 写入缓存并淘汰最旧条目，保证条目数与总字符数有界 */
function storeEntry(
  state: StreamingCacheState,
  key: string,
  entry: StreamingCacheEntry,
): void {
  state.entries.delete(key)
  if (entry.code.length > state.maxCodeLength) return

  state.entries.set(key, entry)

  let totalLength = 0
  for (const item of state.entries.values()) totalLength += item.code.length

  while (state.entries.size > state.maxEntries || totalLength > state.maxTotalCodeLength) {
    const oldestKey = state.entries.keys().next().value
    if (oldestKey === undefined) break
    const oldest = state.entries.get(oldestKey)
    state.entries.delete(oldestKey)
    totalLength -= oldest?.code.length ?? 0
  }
}

/** 命中后把条目移到 Map 末尾，维持 LRU 顺序 */
function touchEntry(state: StreamingCacheState, key: string, entry: StreamingCacheEntry): void {
  state.entries.delete(key)
  state.entries.set(key, entry)
}

/**
 * 复用旧结果的完整行，只重新高亮末尾未完成行与新增内容
 * 返回 null 表示结构不匹配（例如注入的高亮器行数异常），调用方应退回全量重算。
 */
function reuseCompletedLines(
  entry: StreamingCacheEntry,
  nextCode: string,
  options: HighlightOptions,
  tokenize: HighlightTokenizeFn,
): HighlightTokensResult | null {
  const completedLineCount = countNewlines(entry.code)
  if (completedLineCount === 0) return null
  if (entry.result.lines.length !== completedLineCount + 1) return null

  const incompleteLineStart = entry.code.lastIndexOf('\n') + 1
  const suffix = nextCode.slice(incompleteLineStart)
  if (suffix.length === 0) return null

  const tail = tokenize({ ...options, code: suffix })
  if (!tail) return null
  if (tail.lines.length !== countNewlines(suffix) + 1) return null

  const lines = [
    ...entry.result.lines.slice(0, completedLineCount),
    ...tail.lines,
  ]
  if (lines.length !== countNewlines(nextCode) + 1) return null

  return {
    lines,
    bgColor: tail.bgColor,
    fgColor: tail.fgColor,
    language: tail.language,
  }
}

/**
 * 增量高亮入口，返回结构与 highlightToTokens 完全一致
 *
 * - 同一段代码重复调用：直接返回缓存结果（同一对象引用，便于 React bail out）
 * - 追加式流式更新：复用已完成行，只高亮末尾未完成行与新增内容
 * - 编辑既有行 / 语言或主题变化 / 超长代码：全量重算
 * - 高亮器尚未就绪（返回 null）时不写缓存
 */
export function highlightStreamingCode(
  cache: StreamingHighlightCache,
  options: HighlightOptions,
): HighlightTokensResult | null {
  const state = getCacheState(cache)
  const { code, language } = options
  const themeKey = options.theme ?? DEFAULT_THEME
  const key = `${normalizeLanguage(language)}\u0000${themeKey}`
  const entry = state.entries.get(key)

  // 精确命中：流式节流会让同一段代码被重复请求
  if (entry && entry.code === code) {
    touchEntry(state, key, entry)
    return entry.result
  }

  const runFullHighlight = (): HighlightTokensResult | null => {
    const result = state.tokenize(options)
    if (result) {
      storeEntry(state, key, { code, language: normalizeLanguage(language), theme: themeKey, result })
    }
    return result
  }

  if (!entry || !canReuseStreamingTokens(entry.code, code, language, options.theme)) {
    return runFullHighlight()
  }

  const reused = reuseCompletedLines(entry, code, options, state.tokenize)
  if (!reused) return runFullHighlight()

  storeEntry(state, key, {
    code,
    language: normalizeLanguage(language),
    theme: themeKey,
    result: reused,
  })
  return reused
}