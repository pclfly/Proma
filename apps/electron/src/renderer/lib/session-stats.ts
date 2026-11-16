/**
 * session-stats — 会话级用量统计折叠
 *
 * 输入框下方状态栏的数据源。四项读数与 DeepSeek Harness 的 composer 统计对齐：
 * - 输出速度（tok/s）：只统计带解码计时的 assistant 消息，首 token 等待不计入分母
 * - token 用量（tok）：整份会话的计费口径合计 = 提示侧（未缓存 + 缓存读 + 缓存写）+ 输出
 * - 缓存命中率（%）：缓存读取 / 提示侧合计
 * - 上下文使用率（%）：当前上下文占用 / 上下文窗口
 *
 * 折叠口径与 ContextUsageBadge、buildUsageTooltip 一致，避免两处数字打架：
 * 单条 assistant 消息的 usage 里 input_tokens 是未命中缓存的部分，
 * 提示侧大小必须再加上 cache_read / cache_creation。
 *
 * 弹层里的「工具调用用时」是估算值：各轮墙钟（result._durationMs，停止轮为
 * assistant._turnDurationMs）合计减去模型解码耗时，得到非模型占用的时间。
 *
 * 流式预览消息（_partial）没有 usage，参与折叠只会稀释分母，直接跳过。
 */

import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'

/** 状态栏一次渲染需要的全部读数；缺失项为 null，由组件决定隐藏哪一段 */
export interface SessionStats {
  /** 整份会话的计费 token 合计（提示侧 + 输出） */
  totalTokens: number
  /** 缓存命中率（保留一位小数）；从未有过提示侧 token 时为 null */
  cacheHitPercent: number | null
  /** 输出速度（tok/s）；没有任何带解码计时的消息时为 null */
  tokensPerSecond: number | null
  /** 当前上下文占用 token */
  contextTokens: number | null
  /** 上下文窗口大小 */
  contextWindow: number | null
  /** 上下文使用率（整数百分比） */
  contextPercent: number | null
  /** 轮数（一次用户输入起算一轮） */
  turns: number
  /** 步数（一次模型调用算一步） */
  steps: number
  /** 未命中缓存的输入 token（usage.input_tokens 原始值） */
  uncachedInputTokens?: number
  /** 最近一次带计时的模型请求速度（tok/s） */
  latestTokensPerSecond?: number | null
  /** 模型解码耗时合计（ms） */
  modelDurationMs?: number | null
  /** 工具调用耗时估算（整轮耗时 − 模型解码耗时，ms） */
  toolDurationMs?: number | null
  /** 首 token 平均延迟（ms） */
  averageTtftMs?: number | null
}

/** 单条 assistant 消息折叠出的中间量 */
export interface UsageFold {
  /** 提示侧合计（未缓存 + 缓存读 + 缓存写） */
  promptTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** 带解码计时的输出 token 合计 */
  timedOutputTokens: number
  /** 带解码计时的解码耗时合计（ms） */
  decodeMs: number
  /** 主线最后一条非空提示侧的 token 数（用于冷启动时回填上下文占用） */
  lastMainPromptTokens: number | null
  /** 最后一条主线 assistant 的渠道模型 ID（用于回填上下文窗口） */
  lastMainModelId: string | null
  /** 轮数：一次用户输入起算一轮 */
  turns: number
  /** 步数：一次模型调用（带 usage 的 assistant）算一步 */
  steps: number
  /** 未缓存输入 token（usage.input_tokens 原始值） */
  uncachedInputTokens?: number
  /** 最近一次带计时请求的输出 token 与解码耗时 */
  lastTimedOutputTokens?: number
  lastTimedDecodeMs?: number
  /** 所有轮次墙钟合计（result._durationMs 与停止轮的 assistant._turnDurationMs），用于估算工具调用用时 */
  turnDurationMs?: number
  /** 首 token 延迟样本合计与数量 */
  ttftTotalMs?: number
  ttftSamples?: number
}

function emptyFold(): UsageFold {
  return {
    promptTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    timedOutputTokens: 0,
    decodeMs: 0,
    lastMainPromptTokens: null,
    lastMainModelId: null,
    turns: 0,
    steps: 0,
    uncachedInputTokens: 0,
    ttftTotalMs: 0,
    ttftSamples: 0,
  }
}

/** 读取消息上的扩展计时字段（适配器实测写入，历史消息没有） */
function readTiming(message: SDKMessage): { decodeMs?: number } {
  const record = message as unknown as Record<string, unknown>
  const decodeMs = record._decodeMs
  return typeof decodeMs === 'number' && Number.isFinite(decodeMs) && decodeMs > 0 ? { decodeMs } : {}
}

/** 首 token 延迟（ms），仅接受非负有限值。 */
function readTtft(message: SDKMessage): number | undefined {
  const record = message as unknown as Record<string, unknown>
  const ttftMs = record._ttftMs
  return typeof ttftMs === 'number' && Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : undefined
}

/**
 * 轮次墙钟（ms）：停止/错误中断的轮次没有 result 结算，墙钟挂在最后一条 assistant 上。
 * 有 result 的轮次不会写该字段，所以两处累加不会重复计时。
 */
function readTurnDurationMs(message: SDKMessage): number | undefined {
  const record = message as unknown as Record<string, unknown>
  const turnDurationMs = record._turnDurationMs
  return typeof turnDurationMs === 'number' && Number.isFinite(turnDurationMs) && turnDurationMs > 0
    ? turnDurationMs
    : undefined
}

/** 从 SDKMessage[] 折叠出用量中间量（纯函数，测试直接调用） */
export function foldSessionUsage(messages: readonly SDKMessage[]): UsageFold {
  return foldSessionUsageInto(emptyFold(), messages)
}

/**
 * 增量折叠：把 messages 累加到已有 fold 上，返回新的 fold（不改入参）。
 *
 * 流式期间实时消息数组每个 delta 都会换引用，但持久化历史不会变；
 * 调用方可以只对新增的实时消息再做一次增量折叠，把每帧开销从
 * 「全量历史」降到「本轮新增消息」。
 */
export function foldSessionUsageInto(base: UsageFold, messages: readonly SDKMessage[]): UsageFold {
  if (messages.length === 0) return base
  const fold: UsageFold = { ...base }
  // 本轮尚未拿到解码计时的输出 token：若这一轮有 result._durationMs，
  // 就用整轮耗时兜底（历史会话没存 _decodeMs，否则状态栏永远不显示速度）。
  // 一轮里可能有多条未计时 assistant（工具调用往返），但整轮耗时只有一个，
  // 因此每轮只累加一次 denominator，否则会把速度稀释到没有意义。
  let untimedOutputTokens = 0

  for (const message of messages) {
    if (message.type === 'result') {
      const durationMs = (message as unknown as Record<string, unknown>)._durationMs
      if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
        fold.turnDurationMs = (fold.turnDurationMs ?? 0) + durationMs
        if (untimedOutputTokens > 0) {
          fold.timedOutputTokens += untimedOutputTokens
          fold.decodeMs += durationMs
          // 该轮没有逐消息计时：整轮耗时兜底同时也是“最新轮次”的有效样本。
          fold.lastTimedOutputTokens = untimedOutputTokens
          fold.lastTimedDecodeMs = durationMs
        }
      }
      untimedOutputTokens = 0
      continue
    }

    // 轮数按用户输入起算：乐观用户消息与工具结果的 user 消息都不算新一轮，
    // 只统计真正的用户文本输入（不含 tool_result）。
    if (message.type === 'user') {
      const content = (message as SDKUserMessage).message?.content
      const hasToolResult = Array.isArray(content)
        && content.some((block) => (block as { type?: string }).type === 'tool_result')
      if (!hasToolResult && !(message as unknown as Record<string, unknown>).isSynthetic) {
        fold.turns += 1
      }
      continue
    }

    if (message.type !== 'assistant') continue
    // SDKMessage 的兜底成员带字符串索引签名，type 收窄到不了 SDKAssistantMessage，
    // 这里显式断言一次，后续读取 usage/model 才有类型。
    const assistant = message as SDKAssistantMessage
    // 流式预览不带 usage，跳过可避免每帧做无用功
    if ((assistant as unknown as Record<string, unknown>)._partial === true) continue
    const usage = assistant.message?.usage
    if (!usage) continue

    // 步数 = 一次模型调用。子代理（parent_tool_use_id 非空）不计入主线步数，
    // 它们的 token 仍算进会话总量，但「多少步」应是主线视角。
    if (assistant.parent_tool_use_id == null) fold.steps += 1

    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    const promptTokens = usage.input_tokens + cacheRead + cacheWrite
    const outputTokens = usage.output_tokens ?? 0

    fold.promptTokens += promptTokens
    fold.cacheReadTokens += cacheRead
    fold.outputTokens += outputTokens
    fold.uncachedInputTokens = (fold.uncachedInputTokens ?? 0) + usage.input_tokens

    if (promptTokens > 0 && assistant.parent_tool_use_id == null) {
      fold.lastMainPromptTokens = promptTokens
      fold.lastMainModelId = assistant._channelModelId ?? assistant.message?.model ?? null
    }

    const ttftMs = readTtft(assistant)
    if (ttftMs !== undefined) {
      fold.ttftTotalMs = (fold.ttftTotalMs ?? 0) + ttftMs
      fold.ttftSamples = (fold.ttftSamples ?? 0) + 1
    }

    // 停止/报错中断的轮次没有 result，墙钟随最后一条 assistant 落盘。
    const turnDurationMs = readTurnDurationMs(assistant)
    if (turnDurationMs !== undefined) {
      fold.turnDurationMs = (fold.turnDurationMs ?? 0) + turnDurationMs
    }

    const { decodeMs } = readTiming(assistant)
    if (decodeMs !== undefined && outputTokens > 0) {
      fold.timedOutputTokens += outputTokens
      fold.decodeMs += decodeMs
      fold.lastTimedOutputTokens = outputTokens
      fold.lastTimedDecodeMs = decodeMs
    } else if (outputTokens > 0) {
      untimedOutputTokens += outputTokens
    }
  }
  return fold
}

/**
 * 缓存命中率，保留一位小数。
 *
 * 整数四舍五入会把 98.6% 显示成 99%、99.6% 显示成 100%，
 * 让「几乎全命中」和「完全命中」看起来一样。这里：
 * - 保留一位小数，读数本身更有信息量
 * - 只要还有未命中就封顶 99.9%，绝不把部分命中报成 100%
 */
export function cacheHitPercentOf(cacheReadTokens: number, promptTokens: number): number | null {
  if (promptTokens <= 0) return null
  if (cacheReadTokens >= promptTokens) return 100
  const ratio = (cacheReadTokens / promptTokens) * 100
  const rounded = Math.round(ratio * 10) / 10
  return Math.min(99.9, Math.max(0, rounded))
}

/** 输出速度（tok/s）：<10 保留一位小数，避免早期采样显示成 0 */
export function tokensPerSecondOf(timedOutputTokens: number, decodeMs: number): number | null {
  if (decodeMs <= 0 || timedOutputTokens <= 0) return null
  const tps = timedOutputTokens / (decodeMs / 1000)
  if (!Number.isFinite(tps) || tps <= 0) return null
  return tps
}

/** 状态栏 token 数的紧凑写法：517 / 12.2K / 945K / 1.2M */
export function formatCompactTokens(tokens: number): string {
  const scaled = (value: number): string => (value >= 100
    ? String(Math.round(value))
    : String(Math.round(value * 10) / 10))
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)))
  if (tokens < 1_000_000) return `${scaled(tokens / 1_000)}K`
  if (tokens < 1_000_000_000) return `${scaled(tokens / 1_000_000)}M`
  return `${scaled(tokens / 1_000_000_000)}B`
}

/** 状态栏速度写法，与 formatCompactTokens 的精度规则保持一致 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 折叠结果 → 状态栏读数；上下文与窗口优先取流式权威值，缺失时用折叠值回填 */
export function statsFromFold(
  fold: UsageFold,
  liveContextTokens?: number,
  liveContextWindow?: number,
  inferWindow?: (modelId?: string) => number | undefined,
  configuredContextWindow?: number,
): SessionStats {
  const contextTokens = liveContextTokens != null && liveContextTokens > 0
    ? liveContextTokens
    : fold.lastMainPromptTokens

  // 用户为渠道模型显式配置的窗口优先于运行时事件与按模型名推断：
  // 自定义网关上的模型（如 baidu/ernie-5.5-flash-preview:free）不在推断表内，
  // 一旦运行时的 context_window 事件未到达，状态栏会永久回落到 200K 默认值。
  const inferredWindow = configuredContextWindow != null && configuredContextWindow > 0
    ? configuredContextWindow
    : (liveContextWindow != null && liveContextWindow > 0)
      ? liveContextWindow
      : inferWindow?.(fold.lastMainModelId ?? undefined)
  const contextWindow = inferredWindow != null && inferredWindow > 0 ? inferredWindow : null

  const contextPercent = contextTokens != null && contextWindow != null && contextWindow > 0
    ? Math.max(0, Math.round((contextTokens / contextWindow) * 100))
    : null

  return {
    totalTokens: fold.promptTokens + fold.outputTokens,
    cacheHitPercent: cacheHitPercentOf(fold.cacheReadTokens, fold.promptTokens),
    tokensPerSecond: tokensPerSecondOf(fold.timedOutputTokens, fold.decodeMs),
    contextTokens,
    contextWindow,
    contextPercent,
    turns: fold.turns,
    steps: fold.steps,
    uncachedInputTokens: fold.uncachedInputTokens ?? 0,
    latestTokensPerSecond: tokensPerSecondOf(
      fold.lastTimedOutputTokens ?? 0,
      fold.lastTimedDecodeMs ?? 0,
    ),
    modelDurationMs: fold.decodeMs > 0 ? fold.decodeMs : null,
    // 工具用时用“整轮耗时 − 模型解码耗时”估算；没有 result 计时时为未知。
    toolDurationMs: fold.turnDurationMs !== undefined && fold.turnDurationMs > 0
      ? Math.max(0, fold.turnDurationMs - fold.decodeMs)
      : null,
    averageTtftMs: fold.ttftSamples !== undefined && fold.ttftSamples > 0
      ? (fold.ttftTotalMs ?? 0) / fold.ttftSamples
      : null,
  }
}

/** 状态栏明细里的中文耗时：30分3秒 / 7.7秒 / 850毫秒。 */
export function formatStatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '暂无'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}毫秒`
  const totalSeconds = ms / 1000
  if (totalSeconds < 10) return `${Math.round(totalSeconds * 10) / 10}秒`
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}秒`
  const totalRounded = Math.round(totalSeconds)
  const minutes = Math.floor(totalRounded / 60)
  const seconds = totalRounded % 60
  return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`
}

interface ComputeSessionStatsInput {
  /** 参与折叠的全部消息（持久化 + 实时，已按 uuid 去重） */
  messages: readonly SDKMessage[]
  /** 流式状态里的实时上下文占用（权威值） */
  liveContextTokens?: number
  /** 流式状态里的上下文窗口 */
  liveContextWindow?: number
  /** 冷启动回填用的上下文窗口推断函数，避免本模块依赖 shared 的具体模型表 */
  inferWindow?: (modelId?: string) => number | undefined
}

/** 一次性折叠出全部读数（测试与冷启动路径用；流式热路径应走增量折叠） */
export function computeSessionStats(input: ComputeSessionStatsInput): SessionStats {
  return statsFromFold(
    foldSessionUsage(input.messages),
    input.liveContextTokens,
    input.liveContextWindow,
    input.inferWindow,
  )
}

/** 收集消息 uuid，供合并/去重判断使用 */
export function collectMessageUuids(messages: readonly SDKMessage[]): Set<string> {
  const uuids = new Set<string>()
  for (const message of messages) {
    const uuid = (message as unknown as Record<string, unknown>).uuid
    if (typeof uuid === 'string' && uuid.length > 0) uuids.add(uuid)
  }
  return uuids
}

/**
 * 只保留持久化历史里没有的实时消息。
 *
 * 续跑或刷新瞬间同一 uuid 会同时出现在两边；若都折叠，总量与速度会翻倍。
 * 持久化侧已经落盘，口径更权威，因此丢弃重复的实时副本。
 */
export function liveMessagesNotInPersisted(
  persisted: readonly SDKMessage[],
  live: readonly SDKMessage[],
  persistedUuids: ReadonlySet<string> = collectMessageUuids(persisted),
): SDKMessage[] {
  if (live.length === 0) return live as SDKMessage[]
  const unique: SDKMessage[] = []
  const seen = new Set<string>()
  for (const message of live) {
    const uuid = (message as unknown as Record<string, unknown>).uuid
    if (typeof uuid === 'string' && uuid.length > 0) {
      if (persistedUuids.has(uuid) || seen.has(uuid)) continue
      seen.add(uuid)
    }
    unique.push(message)
  }
  return unique
}

/**
 * 把持久化消息与实时消息合并成一份列表。
 *
 * 复用 uuid 去重语义：实时消息覆盖同 uuid 的持久化快照，
 * 避免「续跑瞬间」同一条 assistant 被折叠两次而让总量虚高。
 */
export function mergeSessionMessages(
  persisted: readonly SDKMessage[],
  live: readonly SDKMessage[],
): SDKMessage[] {
  if (live.length === 0) return persisted as SDKMessage[]
  const result: SDKMessage[] = []
  const uuidIndex = new Map<string, number>()
  const push = (message: SDKMessage): void => {
    const uuid = (message as unknown as Record<string, unknown>).uuid
    if (typeof uuid === 'string' && uuid.length > 0) {
      const existing = uuidIndex.get(uuid)
      if (existing !== undefined) {
        result[existing] = message
        return
      }
      uuidIndex.set(uuid, result.length)
    }
    result.push(message)
  }
  for (const message of persisted) push(message)
  for (const message of live) push(message)
  return result
}

/** 状态栏值相等判定：数字没变就不触发重渲染（流式期间每个 delta 都会重算） */
export function areSessionStatsEqual(a: SessionStats, b: SessionStats): boolean {
  return a.totalTokens === b.totalTokens
    && a.cacheHitPercent === b.cacheHitPercent
    && a.tokensPerSecond === b.tokensPerSecond
    && a.contextTokens === b.contextTokens
    && a.contextWindow === b.contextWindow
    && a.contextPercent === b.contextPercent
    && a.turns === b.turns
    && a.steps === b.steps
    && a.uncachedInputTokens === b.uncachedInputTokens
    && a.latestTokensPerSecond === b.latestTokensPerSecond
    && a.modelDurationMs === b.modelDurationMs
    && a.toolDurationMs === b.toolDurationMs
    && a.averageTtftMs === b.averageTtftMs
}
