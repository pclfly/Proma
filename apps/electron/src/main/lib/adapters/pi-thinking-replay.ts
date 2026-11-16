/**
 * Pi thinking replay 策略。
 *
 * 官方 0.22.0 引入：默认只回传“最后一轮用户消息之后”的签名绑定 thinking 块，
 * 避免历史 thinking 与当前上下文/模型不匹配导致上游 400；同时提供
 * legacy/turn/none 三种模式与按会话强制剥离（opaque 400 / 签名不兼容时）。
 *
 * 另提供前缀指纹，用于诊断“首字节缓存/签名失配”来自哪一段上下文。
 */

import { createHash } from 'node:crypto'

export type ThinkingReplayMode = 'legacy' | 'turn' | 'none'

export interface ThinkingPrefixFingerprint {
  at: number
  systemHash: string
  systemLength: number
  conversationHash: string
  messageCount: number
  signedThinkingCount: number
}

export interface ThinkingReplayState {
  mode: ThinkingReplayMode
  fingerprints: ThinkingPrefixFingerprint[]
}

const MAX_FINGERPRINTS = 3
const FORCED_STRIP_TTL_MS = 6 * 60 * 60 * 1_000
const forcedStripSessions = new Map<string, number>()
const TURN_BOUNDARY_ROLES = new Set(['user', 'custom', 'bashExecution', 'branchSummary', 'compactionSummary'])
const OPAQUE_UPSTREAM_400 = /upstream http 400|upstream request failed/i

interface MessageLike {
  role?: unknown
  content?: unknown
  sections?: unknown
}

interface ThinkingBlockLike {
  type?: unknown
  thinkingSignature?: unknown
}

function isAssistantWithBlocks(message: unknown): message is { role: 'assistant'; content: unknown[] } {
  if (!message || typeof message !== 'object') return false
  const record = message as MessageLike
  return record.role === 'assistant' && Array.isArray(record.content)
}

function isThinkingBlock(block: unknown): block is ThinkingBlockLike {
  if (!block || typeof block !== 'object') return false
  return (block as ThinkingBlockLike).type === 'thinking'
}

function isSignatureBoundThinkingBlock(block: unknown): boolean {
  if (!isThinkingBlock(block)) return false
  return typeof block.thinkingSignature === 'string' && block.thinkingSignature.length > 0
}

function systemTextOf(message: MessageLike): string {
  const content = typeof message.content === 'string' ? message.content : ''
  return message.sections === undefined ? content : `${content}\0${JSON.stringify(message.sections)}`
}

export function createThinkingReplayState(mode: ThinkingReplayMode = 'turn'): ThinkingReplayState {
  return { mode, fingerprints: [] }
}

/** 读取 PROMA_THINKING_REPLAY_MODE；非法值返回 undefined，由调用方决定默认值。 */
export function resolveThinkingReplayMode(
  raw: string | undefined = typeof process === 'undefined' ? undefined : process.env.PROMA_THINKING_REPLAY_MODE,
): ThinkingReplayMode | undefined {
  const value = raw?.trim().toLowerCase()
  return value === 'legacy' || value === 'turn' || value === 'none' ? value : undefined
}

/** 下一次为该会话创建 Pi session 时强制剥离历史 thinking（TTL 6 小时）。 */
export function armThinkingStripForSession(sessionId: string | undefined, now = Date.now()): void {
  if (!sessionId) return
  forcedStripSessions.set(sessionId, now + FORCED_STRIP_TTL_MS)
}

/** 读取并清除强制剥离标记；已过期视为未命中。 */
export function consumeThinkingStripForSession(sessionId: string | undefined, now = Date.now()): boolean {
  if (!sessionId) return false
  const expiresAt = forcedStripSessions.get(sessionId)
  if (expiresAt === undefined) return false
  forcedStripSessions.delete(sessionId)
  return expiresAt > now
}

function findLastTurnBoundaryIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = message && typeof message === 'object' ? (message as MessageLike).role : undefined
    if (typeof role === 'string' && TURN_BOUNDARY_ROLES.has(role)) return index
  }
  return -1
}

function hasCompactionSummary(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false
    return (message as MessageLike).role === 'compactionSummary'
  })
}

/**
 * 按策略剥离签名绑定 thinking 块。
 *
 * - legacy：不处理（保持旧行为）。
 * - turn：只保留最后一轮边界之后的 thinking；存在 compaction summary 时全量剥离。
 * - none：全量剥离。
 * - 非 anthropic-messages 协议不处理（OpenAI 协议不要求回传 thinking 签名）。
 */
export function applyThinkingReplayPolicy<T>(
  messages: T[],
  state: ThinkingReplayState,
  options: { supported: boolean },
): T[] {
  if (!options.supported || messages.length === 0) return messages
  if (state.mode === 'legacy') return messages

  const turnBoundaryIndex = findLastTurnBoundaryIndex(messages)
  const dropAll = state.mode === 'none' || hasCompactionSummary(messages) || turnBoundaryIndex < 0
  let changed = false
  const next = messages.map((message, index) => {
    if (!isAssistantWithBlocks(message)) return message
    if (!dropAll && index > turnBoundaryIndex) return message
    const blocks = message.content
    const kept = blocks.filter((block) => !isSignatureBoundThinkingBlock(block))
    if (kept.length === blocks.length) return message
    changed = true
    return { ...(message as object), content: kept } as T
  })
  return changed ? next : messages
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** 生成当前请求前缀指纹：system 段、会话序列、可回传 thinking 数。 */
export function buildPrefixFingerprint(messages: readonly unknown[], now = Date.now()): ThinkingPrefixFingerprint {
  const systemParts: string[] = []
  const conversationParts: string[] = []
  let messageCount = 0
  let signedThinkingCount = 0

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as MessageLike
    if (record.role === 'system') {
      systemParts.push(systemTextOf(record))
      continue
    }
    messageCount += 1
    conversationParts.push(JSON.stringify(message))
    if (isAssistantWithBlocks(message)) {
      for (const block of message.content) {
        if (isSignatureBoundThinkingBlock(block)) signedThinkingCount += 1
      }
    }
  }

  const systemText = systemParts.join('\0')
  return {
    at: now,
    systemHash: hashOf(systemText),
    systemLength: systemText.length,
    conversationHash: hashOf(conversationParts.join('\0')),
    messageCount,
    signedThinkingCount,
  }
}

/** 只保留最近 MAX_FINGERPRINTS 条，避免长会话内存增长。 */
export function recordPrefixFingerprint(state: ThinkingReplayState, fingerprint: ThinkingPrefixFingerprint): void {
  state.fingerprints.push(fingerprint)
  if (state.fingerprints.length > MAX_FINGERPRINTS) {
    state.fingerprints.splice(0, state.fingerprints.length - MAX_FINGERPRINTS)
  }
}

/** 描述相邻两次前缀指纹的漂移，用于 none 模式诊断日志。 */
export function describePrefixDrift(state: ThinkingReplayState): string {
  const recent = state.fingerprints
  if (recent.length < 2) return '前缀指纹不足（首次请求即失配，可视为历史 artifact 与当前前缀不一致）'
  const previous = recent[recent.length - 2]
  const current = recent[recent.length - 1]
  if (!previous || !current) return '前缀指纹不足'
  const drift: string[] = []
  if (previous.systemHash !== current.systemHash) {
    drift.push(`system 段变化（${previous.systemLength}→${current.systemLength} 字符）`)
  }
  if (previous.conversationHash !== current.conversationHash) {
    drift.push(`会话序列变化（${previous.messageCount}→${current.messageCount} 条）`)
  }
  if (previous.signedThinkingCount !== current.signedThinkingCount) {
    drift.push(`可回传思考块 ${previous.signedThinkingCount}→${current.signedThinkingCount}`)
  }
  return drift.length > 0 ? drift.join('；') : '前缀指纹一致（失配来自更早的请求或上游侧）'
}

/** Claude 家族模型判定（用于 opaque 400 的 thinking 剥离重试）。 */
export function isClaudeFamilyModelId(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && modelId.toLowerCase().includes('claude')
}

/** 网关隐去原始原因的上游 400。 */
export function isOpaqueUpstream400(...messages: Array<string | undefined>): boolean {
  return OPAQUE_UPSTREAM_400.test(messages.filter((message) => typeof message === 'string').join('\n'))
}
