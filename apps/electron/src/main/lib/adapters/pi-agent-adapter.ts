/**
 * Pi Agent SDK 适配器
 *
 * Proma 内部继续使用 SDKMessage 兼容协议，避免渲染层、Jotai 状态、
 * JSONL 持久化和历史会话展示在 SDK 迁移时一起改名。
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Dispatcher } from 'undici'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentThinkingLevel,
  AgentProviderAdapter,
  CodexOAuthCredentials,
  GithubCopilotOAuthCredentials,
  XaiOAuthCredentials,
  AgentQueryInput,
  JsonSchemaOutputFormat,
  PromaPermissionMode,
  ProviderType,
  SendQueuedMessageOptions,
  SDKMessage,
  AgentAssistantDelta,
  AgentToolCallDelta,
  CodexSpeed,
  SDKUserMessageInput,
  SkillActivation,
} from '@proma/shared'
import {
  calculatePiAutoCompactionReserveTokens,
  isCodexSpeedSupportedModel,
  resolveCodexSpeed,
  resolveReasoningProfile,
  normalizeReasoningLevel,
  type ReasoningProfileConfigData,
  createSkillActivationFromPath,
} from '@proma/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import { isPromptTooLongError } from '../agent-error-utils'

import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  Skill,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Transport as PiAgentTransport } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, ModelImageResizeOptions } from '@earendil-works/pi-ai'
import { serializePiAssistantBlock } from './pi-assistant-block'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { Type, type TSchema } from 'typebox'
import {
  appendOutputFormatInstruction,
  createAgentRuntimeGuard,
  type AgentRuntimeGuard,
} from '../agent-runtime-guards'
import {
  createPromaManagedResourceLoaderOptions,
  createPromaProjectInstructionFilesOverride,
  type PromaProjectInstructionFile,
} from './pi-resource-loader-overrides'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'
import type { ProjectInstructionSource } from '../project-instruction-resolver'
import { createCodexSpeedExtension, withCodexServiceTier } from './pi-codex-request-settings'
import { createSeepProviderSafetyExtension } from './pi-seep-provider-safety'
import { createSeepInputPipelineExtension } from './pi-seep-input-pipeline'
import { createDeepSeekReasoningRequestExtension } from './pi-deepseek-reasoning-request-settings'
import { createOpenAIReasoningRequestExtension } from './pi-openai-reasoning-request-settings'
import { createKimiRequestExtension } from './pi-kimi-request-settings'
import { createVolcengineReasoningRequestExtension } from './pi-volcengine-reasoning-request-settings'
import { mergeRuntimeEnv, type AgentRuntimeEnv } from '../agent-runtime-env'
import { sanitizeToolResultImageContent } from '../image-content-validation'
import { MODEL_IMAGE_RESIZE_OPTIONS, withPromaImageInputLimits } from '../model-image-compression'
import { createAgentImageRequestBudget } from '../agent-image-request-budget'
import {
  convertPiMessage,
  convertResultMessage,
  displayToolName,
  dropTrailingAbortedAssistant,
  hasToolResult,
  isAbortedAssistantMessage,
  isAssistantPiMessage,
} from './pi-message-adapter'
import { createProjectScopeState } from './pi-project-scope-state'
import { wrapToolWithPermission } from './pi-tool-permission'
import { DEFAULT_CONTEXT_WINDOW, buildModel, toReasoningTransport } from './pi-model-registry'
import { PendingPromptSkillActivationTracker } from './pi-skill-activation-tracker'
import { normalizePiToolResultDetails, serializePiToolResultPayload } from './pi-tool-result-json'
import { withPiStreamFinalizationGuard } from './pi-stream-finalization'
import { createPiResponseTimingTracker, type PiResponseTiming } from './pi-response-timing'
import { createPiSessionCleanup } from './pi-session-cleanup'
import { createKnowledgeAwareFileTool } from './pi-knowledge-mutation-observer'
import type { KnowledgeMutationObserver } from '../knowledge-mutation-protocol'
import {
  createPiRetryTerminalGate,
  installPromaRetryClassifier,
  mapPiNativeRetryEvent,
} from './pi-retry-control'
import {
  applyThinkingReplayPolicy,
  buildPrefixFingerprint,
  consumeThinkingStripForSession,
  createThinkingReplayState,
  describePrefixDrift,
  recordPrefixFingerprint,
  resolveThinkingReplayMode,
} from './pi-thinking-replay'
import { createPiCollaborationBoundary } from './pi-collaboration-boundary'
import { refreshMemorySystemMessages } from './pi-memory-context'
import type { AgentMemoryContext } from '../agent-memory'
import { attachInterruptedOutputNotes } from './pi-interrupted-output'
import { buildPiToolFailureGuidance } from './pi-tool-failure-guidance'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
} from './pi-request-proxy'
import { runWithPiSystemNetwork } from './pi-system-fetch'
import { resolvePiModelSystemNetwork } from './pi-system-network'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type BashOperations = import('@earendil-works/pi-coding-agent').BashOperations
type BashToolOptions = import('@earendil-works/pi-coding-agent').BashToolOptions
type PowerShellToolOptions = import('@earendil-works/pi-coding-agent').PowerShellToolOptions
type SkillLoadResult = ReturnType<ResourceLoader['getSkills']>

// Pi 0.86 将单次 agent retry 退避限制为 maxAgentDelayMs（默认 60 秒）。
// Proma 保持约十分钟的重试预算：1 + 2 + 4 + 8 + 16 + 32 + (8 × 60) = 543 秒。
const PI_NATIVE_MAX_RETRIES = 14
const PI_NATIVE_RETRY_BASE_DELAY_MS = 1_000
const PI_NATIVE_MAX_DELAY_MS = 60_000
const MAX_AUTOMATIC_COMPACTION_CONTINUATIONS = 20

// 官方 0.22.0：Shell 工具未传 timeout 时默认 300 秒，显式值封顶 3600 秒；
// 进程树被 kill 后 3 秒仍未收到 close 时兜底结算，避免调用永久挂起。
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300
export const MAX_BASH_TIMEOUT_SECONDS = 3_600
export const KILL_SETTLE_GRACE_MS = 3_000

export function shouldMarkCompactionAfterCompletedTurn(
  terminalResult: SDKMessage | undefined,
  requiresOriginalTaskContinuation: boolean,
): boolean {
  return terminalResult?.type === 'result'
    && terminalResult.subtype === 'success'
    && !requiresOriginalTaskContinuation
}

/** Pi SDK 查询选项（扩展通用 AgentQueryInput） */
export interface PiAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  /** OAuth credential coordination key; equals the selected Proma channel id. */
  channelId?: string
  channelName?: string
  maxTurns?: number
  permissionMode: PromaPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  systemPrompt: string
  /** Proma 已验证的项目根 instruction files；不触发 Pi 的磁盘自动发现。 */
  projectInstructionFiles?: PromaProjectInstructionFile[]
  /** 用于 typed 文件工具的会话级子目录指令激活；不会解析 Bash。 */
  projectInstructionScope?: {
    projectRoot: string
    initialSources: ProjectInstructionSource[]
  }
  resumeSessionId?: string
  piAgentDir: string
  piSessionDir: string
  customTools?: ToolDefinition[]
  onSessionId?: (sdkSessionId: string, sessionFile?: string) => void
  /** Pi final assistant UI UUID → 持久树状 session entry ID。 */
  onPiEntryBindings?: (bindings: Record<string, string>) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (contextWindow: number) => void
  onRetry?: (update: import('./pi-retry-control').PiRetryUpdate) => void
  /** 渲染进程创建的本轮流式开始时间，用于隔离迟到的 native retry 事件。 */
  retryRunStartedAt?: number
  thinkingLevel?: AgentThinkingLevel
  /** 主进程在本轮开始时生成的完整配置快照；跨 utility 边界传输，不依赖模块全局状态。 */
  reasoningProfiles?: ReasoningProfileConfigData[]
  maxBudgetUsd?: number
  outputFormat?: JsonSchemaOutputFormat
  /** Proma 聚合的附加目录；Pi 内置工具 factory 不接收多 root 参数，编排层会把它们注入 systemPrompt。 */
  additionalDirectories?: string[]
  additionalSkillPaths?: string[]
  /**
   * 破甲开启时启用 Seep 的 provider 放行扩展：仅对 Google 端点注入
   * `safetySettings = BLOCK_NONE`，OpenAI 兼容端点原样透传。
   * 由编排层按 `personalDirective.enabled` 决定，未传即关闭。
   */
  seepProviderSafety?: boolean
  /**
   * 破甲开启时启用 Seep 的 input/context 管线扩展：
   * - `input`：口语转译为白盒审计术语 + 合规包裹（只改用户输入，跳过斜杠命令与注入上下文）
   * - `context`：生成前清洗历史消息里的阻断残留
   * 由编排层按 `personalDirective.enabled` 决定，未传即关闭。
   */
  seepInputPipeline?: boolean
  /** 当前用户输入显式引用的 Skill name（兼容历史 slug 已在编排层归一化） */
  skillMentions?: string[]
  /** Persisted user-message UUID for turn-scoped Skill attribution. */
  initialUserMessageUuid?: string
  /** Workspace that owns `additionalSkillPaths`, used for relocatable Skill previews. */
  skillWorkspaceSlug?: string
  /** Skill 成功加载并注入 prompt 后回调。 */
  onSkillActivated?: (activations: SkillActivation[], userMessageUuid: string) => void
  /** 仅主进程内部的记忆/规则提交观察器；跨 utility 时由 capability RPC 重建。 */
  knowledgeMutationObserver?: KnowledgeMutationObserver
  /** 父会话 settle 前的协作收口回调；由 builtin collaboration tools 提供。 */
  onCollaborationBoundary?: import('../agent-collaboration-tools').CollaborationBoundaryHandler
  /** 已授权工作区的 Agent Memory 上下文；提供时每轮请求刷新 proma_memory section。 */
  memoryContext?: AgentMemoryContext
  proxyUrl?: string
  /** Pi 模型请求传输策略：auto / sse / websocket / websocket-cached */
  transport?: PiAgentTransport
  /** HTTP 头/响应体空闲超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  httpIdleTimeoutMs?: number
  /** WebSocket 建连超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  websocketConnectTimeoutMs?: number
  runtimeEnv?: AgentRuntimeEnv
  /** 手动压缩请求：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型 */
  compactRequest?: boolean
  /** 渠道配置中用户为当前模型指定的上下文窗口覆盖（token 数）；缺失时按模型名/目录推断。 */
  channelModelContextWindow?: number
  /** ChatGPT Codex 速度档；仅 openai-codex 的受支持模型实际注入 service tier。 */
  codexSpeed?: CodexSpeed
  /** @deprecated 使用 codexSpeed；true 等价于 fast。 */
  codexFastMode?: boolean
  /** Pi 的 OAuth credential store 使用真实 expires 和 refresh，不读取 ~/.pi。 */
  codexOAuthCredentials?: CodexOAuthCredentials
  /** Pi 运行中刷新 OAuth 后，将新凭据回写到 Proma 渠道存储。 */
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
  /** GitHub Copilot OAuth credential store 使用真实 expires、模型策略和 refresh，不读取 ~/.pi。 */
  githubCopilotOAuthCredentials?: GithubCopilotOAuthCredentials
  /** Pi 运行中刷新 GitHub Copilot OAuth 后，将新凭据及模型策略回写到 Proma 渠道存储。 */
  onGithubCopilotOAuthCredentialsRefreshed?: (credentials: GithubCopilotOAuthCredentials) => void | Promise<void>
  /** xAI OAuth credential store 使用真实 expires 和 refresh，不读取 ~/.pi。 */
  xaiOAuthCredentials?: XaiOAuthCredentials
  /** Pi 运行中刷新 xAI OAuth 后，将新凭据回写到 Proma 渠道存储。 */
  onXaiOAuthCredentialsRefreshed?: (credentials: XaiOAuthCredentials) => void | Promise<void>
  /** 会话级 OpenAI（Codex OAuth / Responses API）思考深度。 */
  openAIThinkingLevel?: AgentThinkingLevel
}

interface ActivePiSession {
  session?: AgentSession
  resourceLoader?: ResourceLoader
  ready: Promise<AgentSession>
  resolveReady: (session: AgentSession) => void
  rejectReady: (error: unknown) => void
  abortRequested: boolean
  abortController: AbortController
  interrupting: boolean
  pendingInterruptPrompts: PendingInterruptPrompt[]
  interruptAbortPromise?: Promise<void>
  readySettled: boolean
  disposed: boolean
  runtimeGuard?: AgentRuntimeGuard
  skillWorkspaceSlug?: string
  pendingSkillActivations: PendingPromptSkillActivationTracker
  onSkillActivated?: (activations: SkillActivation[], userMessageUuid: string) => void
}

interface PendingInterruptPrompt {
  content: string
  skillActivationId?: number
  resolveAccepted: () => void
  rejectAccepted: (error: unknown) => void
}

interface AssistantMessageState {
  uuid?: string
}

/**
 * 同一 assistant 流在 Pi native retry 前后必须复用 UUID：renderer 才能用恢复后的
 * partial/final frame 原地替换断流前的 partial，而不是把两段回答并排追加。
 */
export function createPiAssistantUuidTracker(createUuid: () => string = randomUUID): {
  get: () => string
  reset: () => void
} {
  let state: AssistantMessageState = {}

  return {
    get: () => {
      if (!state.uuid) state = { uuid: createUuid() }
      if (!state.uuid) throw new Error('Pi assistant message uuid 初始化失败')
      return state.uuid
    },
    reset: () => { state = {} },
  }
}

function toolCallDeltaFromPartial(event: Extract<AssistantMessageEvent, { type: 'toolcall_start' | 'toolcall_delta' }>): AgentToolCallDelta | undefined {
  const block = event.partial.content[event.contentIndex]
  if (!block || block.type !== 'toolCall') return undefined
  return {
    id: block.id,
    name: displayToolName(block.name, block.arguments as Record<string, unknown>),
    ...(event.type === 'toolcall_delta' ? {} : { arguments: {} }),
  }
}

/** Extract only the small structured delta from Pi's cumulative message_update event. */
export function serializePiAssistantDelta(event: AssistantMessageEvent): AgentAssistantDelta | undefined {
  switch (event.type) {
    case 'start': return { type: 'start' }
    case 'text_start': return { type: 'text_start', contentIndex: event.contentIndex }
    case 'text_delta': return { type: 'text_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'text_end': return { type: 'text_end', contentIndex: event.contentIndex, content: event.content }
    case 'thinking_start': return { type: 'thinking_start', contentIndex: event.contentIndex }
    case 'thinking_delta': return { type: 'thinking_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'thinking_end': return { type: 'thinking_end', contentIndex: event.contentIndex, content: event.content }
    case 'toolcall_start': {
      // 与 official assistant_blocks 共用同一套 tool_use 投影，避免显示名/参数归一化漂移。
      const blockEvent = serializePiAssistantBlock(event)
      const block = blockEvent?.type === 'block_start' && blockEvent.block.type === 'tool_use'
        ? blockEvent.block
        : undefined
      const toolCall = block
        ? { id: block.id, name: block.name, arguments: {} }
        : toolCallDeltaFromPartial(event)
      return { type: 'toolcall_start', contentIndex: event.contentIndex, ...(toolCall ? { toolCall } : {}) }
    }
    case 'toolcall_delta': {
      const toolCall = toolCallDeltaFromPartial(event)
      return { type: 'toolcall_delta', contentIndex: event.contentIndex, delta: event.delta, ...(toolCall ? { toolCall } : {}) }
    }
    case 'toolcall_end': {
      const blockEvent = serializePiAssistantBlock(event)
      const block = blockEvent?.type === 'block' && blockEvent.block.type === 'tool_use'
        ? blockEvent.block
        : undefined
      return {
        type: 'toolcall_end',
        contentIndex: event.contentIndex,
        toolCall: block
          ? { id: block.id, name: block.name, arguments: block.input }
          : {
              id: event.toolCall.id,
              name: displayToolName(event.toolCall.name, event.toolCall.arguments as Record<string, unknown>),
              arguments: event.toolCall.arguments as Record<string, unknown>,
            },
      }
    }
    default:
      return undefined
  }
}

export interface PiRemoteConnectionSettings {
  httpProxy?: string
  transport?: PiAgentTransport
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
}

interface AsyncQueue<T> {
  push: (value: T) => void
  fail: (error: unknown) => void
  close: () => void
  next: () => Promise<IteratorResult<T>>
}

function getCaseInsensitiveRuntimeEnvValue(env: Record<string, string> | undefined, key: string): string | undefined {
  if (!env) return undefined
  const exact = env[key]
  if (exact) return exact
  const foundKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = foundKey ? env[foundKey] : undefined
  return value || undefined
}

function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
  const trimmed = proxyUrl?.trim()
  return trimmed ? trimmed : undefined
}

function resolvePiHttpProxy(input: Pick<PiAgentQueryOptions, 'proxyUrl' | 'runtimeEnv'>): string | undefined {
  return normalizeProxyUrl(input.proxyUrl)
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTPS_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTP_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'ALL_PROXY'))
}

function isNonNegativeFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

export function buildPiRemoteConnectionSettings(
  input: Pick<
    PiAgentQueryOptions,
    'provider' | 'proxyUrl' | 'runtimeEnv' | 'transport' | 'httpIdleTimeoutMs' | 'websocketConnectTimeoutMs'
  >,
): PiRemoteConnectionSettings {
  const httpProxy = resolvePiHttpProxy(input)
  // Node/Electron 的 WebSocket 不支持请求级 HTTP 代理注入；有代理的 Codex
  // 默认改走可由 undici dispatcher 承载的 SSE。用户显式选择 transport 时保留其意图。
  const transport = input.transport ?? (httpProxy && input.provider === 'openai-codex' ? 'sse' : undefined)
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(transport ? { transport } : {}),
    ...(isNonNegativeFiniteNumber(input.httpIdleTimeoutMs) ? { httpIdleTimeoutMs: input.httpIdleTimeoutMs } : {}),
    ...(isNonNegativeFiniteNumber(input.websocketConnectTimeoutMs)
      ? { websocketConnectTimeoutMs: input.websocketConnectTimeoutMs }
      : {}),
  }
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: unknown

  const flush = (): void => {
    while (waiters.length > 0 && (values.length > 0 || closed || failure)) {
      const waiter = waiters.shift()!
      if (values.length > 0) {
        waiter({ value: values.shift()!, done: false })
      } else if (failure) {
        const err = failure
        failure = undefined
        Promise.resolve().then(() => { throw err }).catch(() => {})
        waiter(Promise.reject(err) as unknown as IteratorResult<T>)
      } else {
        waiter({ value: undefined, done: true })
      }
    }
  }

  return {
    push(value) {
      if (closed) return
      values.push(value)
      flush()
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      flush()
    },
    close() {
      closed = true
      flush()
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ value: values.shift()!, done: false })
      }
      if (failure) {
        const err = failure
        failure = undefined
        return Promise.reject(err)
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve))
    },
  }
}

const SESSION_READY_TIMEOUT_MS = 60_000
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

function createActivePiSession(): ActivePiSession {
  let resolveReady!: (session: AgentSession) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<AgentSession>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  ready.catch(() => {})
  return {
    ready,
    resolveReady,
    rejectReady,
    abortRequested: false,
    abortController: new AbortController(),
    interrupting: false,
    pendingInterruptPrompts: [],
    pendingSkillActivations: new PendingPromptSkillActivationTracker(),
    readySettled: false,
    disposed: false,
  }
}

function resolveActiveReady(active: ActivePiSession, session: AgentSession): void {
  if (active.readySettled) return
  active.readySettled = true
  active.resolveReady(session)
}

function rejectActiveReady(active: ActivePiSession, error: unknown): void {
  if (active.readySettled) return
  active.readySettled = true
  active.rejectReady(error)
}

function createAbortError(): Error {
  const error = new Error('Agent 执行已停止')
  error.name = 'AbortError'
  return error
}

function rejectPendingInterruptPrompts(active: ActivePiSession, error: unknown): void {
  const pending = active.pendingInterruptPrompts.splice(0)
  for (const prompt of pending) {
    active.pendingSkillActivations.discard(prompt.skillActivationId)
    prompt.rejectAccepted(error)
  }
}

async function waitForActiveSession(active: ActivePiSession): Promise<AgentSession> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      active.ready,
      new Promise<AgentSession>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Agent 会话初始化超时，请稍后重试')), SESSION_READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function findSessionFile(sessionDir: string, sdkSessionId: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined
  for (const entry of readdirSync(sessionDir)) {
    if (entry.endsWith('.jsonl') && entry.includes(sdkSessionId)) {
      return join(sessionDir, entry)
    }
  }
  return undefined
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function buildAllowedSkillRoots(additionalSkillPaths: string[] | undefined): string[] {
  return (additionalSkillPaths ?? [])
    .map((path) => resolveGuardedRealPath(path))
    .filter((path, index, arr) => arr.indexOf(path) === index)
}

function isPromaSkillPath(path: string | undefined, allowedRoots: string[]): boolean {
  if (!path || allowedRoots.length === 0) return false
  const guardedPath = resolveGuardedRealPath(path)
  return allowedRoots.some((root) => isPathWithinRoot(guardedPath, root))
}

function createPromaSkillsOverride(additionalSkillPaths: string[] | undefined): (base: SkillLoadResult) => SkillLoadResult {
  const allowedRoots = buildAllowedSkillRoots(additionalSkillPaths)
  return (base) => ({
    skills: base.skills.filter((skill) =>
      isPromaSkillPath(skill.filePath, allowedRoots) || isPromaSkillPath(skill.baseDir, allowedRoots)),
    diagnostics: base.diagnostics.filter((diagnostic) => isPromaSkillPath(diagnostic.path, allowedRoots)),
  })
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)
  return frontmatter ? normalized.slice(frontmatter[0].length) : content
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function skillCommandAliases(skill: Skill): string[] {
  const aliases = [skill.name, basename(skill.baseDir), basename(dirname(skill.filePath))]
  return aliases.filter((alias, index, arr) => Boolean(alias) && arr.indexOf(alias) === index)
}

function extractSkillCommandNames(prompt: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function buildSkillLookup(skills: Skill[]): Map<string, Skill> {
  const lookup = new Map<string, Skill>()
  for (const skill of skills) {
    for (const alias of skillCommandAliases(skill)) {
      if (!lookup.has(alias)) lookup.set(alias, skill)
    }
  }
  return lookup
}

function formatSkillForPrompt(skill: Skill): string | undefined {
  try {
    const body = stripSkillFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim()
    return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  } catch (error) {
    console.warn(`[Pi SDK] Skill 展开失败: ${skill.filePath}`, error)
    return undefined
  }
}

interface PreparedPromptWithSkills {
  content: string
  activations: SkillActivation[]
}

async function preparePromptWithPromaSkills(
  resourceLoader: ResourceLoader,
  prompt: string,
  explicitSkillNames?: string[],
  workspaceSlug?: string,
): Promise<PreparedPromptWithSkills> {
  await resourceLoader.reload()

  const requestedNames = explicitSkillNames?.length ? explicitSkillNames : extractSkillCommandNames(prompt)
  if (requestedNames.length === 0) return { content: prompt, activations: [] }

  const skillLookup = buildSkillLookup(resourceLoader.getSkills().skills)
  const blocks: string[] = []
  const activations: SkillActivation[] = []
  const injectedSkillNames = new Set<string>()

  for (const requestedName of requestedNames) {
    const skill = skillLookup.get(requestedName)
    if (!skill || injectedSkillNames.has(skill.name)) continue
    const block = formatSkillForPrompt(skill)
    if (!block) continue
    injectedSkillNames.add(skill.name)
    const activation = createSkillActivationFromPath(
      skill.filePath,
      'explicit',
      skill.name,
      workspaceSlug,
    )
    if (activation) activations.push(activation)
    blocks.push(block)
  }

  if (blocks.length === 0) return { content: prompt, activations: [] }
  return {
    content: `${blocks.join('\n\n')}\n\n${prompt}`,
    activations,
  }
}

function getPiUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const userMessage = message as { role?: unknown; content?: unknown }
  if (userMessage.role !== 'user' || !Array.isArray(userMessage.content)) return undefined
  const text = userMessage.content
    .filter((block): block is { type: 'text'; text: string } => (
      Boolean(block)
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('')
  return text || undefined
}

function registerPromptSkillActivations(
  active: ActivePiSession,
  prompt: string,
  userMessageUuid: string | undefined,
  activations: SkillActivation[],
): number | undefined {
  if (!userMessageUuid) return undefined
  return active.pendingSkillActivations.register(prompt, userMessageUuid, activations)
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function findNearestExistingPath(path: string): string | undefined {
  let current = path
  while (true) {
    try {
      lstatSync(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

function resolveGuardedRealPath(path: string): string {
  const resolved = resolve(path)
  const exact = realpathIfExists(resolved)
  if (exact) return exact

  const nearestExisting = findNearestExistingPath(resolved)
  if (!nearestExisting) return resolved

  const nearestReal = realpathIfExists(nearestExisting)
  if (!nearestReal) return resolved

  const tail = relative(nearestExisting, resolved)
  return tail ? resolve(nearestReal, tail) : nearestReal
}

function createJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text', text: serialized.text }],
    details: serialized.details,
  } as AgentToolResult<unknown>
}

function createTextToolResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    ...(details === undefined ? {} : { details: normalizePiToolResultDetails(details) }),
  } as AgentToolResult<unknown>
}

function createTerminatingJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    ...createJsonToolResult(payload),
    // Compaction must run only after the active Pi agent loop has settled. Continuing
    // this turn would otherwise race with session.compact(), which aborts that loop.
    terminate: true,
  } as AgentToolResult<unknown>
}

export const PI_COMPACTION_CONTINUATION_PROMPT = `<proma_compaction_continuation>
当前会话上下文已经安全压缩。请依据压缩摘要、保留的最近上下文和已持久化的交接状态，继续完成原始用户任务。

- 不要重复已经完成或已提交的操作；先核验当前状态。
- 若仍有工作，立即执行下一项具体行动。
- 只有原始需求全部完成时才给出最终答复；若确实受阻，明确说明阻塞原因。
</proma_compaction_continuation>`

export function planPiCompactionContinuation(options: {
  continuationCount: number
  abortRequested: boolean
  runtimeLimitReached: boolean
}):
  | { shouldContinue: true; prompt: string }
  | { shouldContinue: false; reason: 'aborted' | 'runtime_limit' | 'continuation_limit' } {
  if (options.abortRequested) return { shouldContinue: false, reason: 'aborted' }
  if (options.runtimeLimitReached) return { shouldContinue: false, reason: 'runtime_limit' }
  if (options.continuationCount >= MAX_AUTOMATIC_COMPACTION_CONTINUATIONS) {
    return { shouldContinue: false, reason: 'continuation_limit' }
  }
  return { shouldContinue: true, prompt: PI_COMPACTION_CONTINUATION_PROMPT }
}

export function canRunCurrentSessionCompaction(toolNames: string[]): boolean {
  return toolNames.length === 1 && toolNames[0] === 'CompactContext'
}

/** AskUserQuestion 必须暂停整个工具批次，不能与后续动作混合执行。 */
export function shouldBlockToolForAskUserQuestion(toolNames: string[], toolName: string): boolean {
  return toolName !== 'AskUserQuestion'
    && toolNames.includes('AskUserQuestion')
    && toolNames.length > 1
}

/**
 * Pi emits `agent_end` before it decides whether an error needs overflow
 * compaction. Keep this one error class local until the matching compaction
 * lifecycle reaches a terminal state, otherwise the outer orchestrator can
 * dispose the session before Pi calls `agent.continue()`.
 */
function isPiContextOverflow(message: AssistantMessage, contextWindow: number | undefined): boolean {
  if (message.stopReason === 'error' && isPromptTooLongError(message.errorMessage)) return true

  if (contextWindow && message.stopReason === 'length' && message.usage?.output === 0) {
    const inputTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0)
    return inputTokens >= contextWindow * 0.99
  }

  return false
}

export function shouldDeferPiOverflowTerminalMessage(
  message: AssistantMessage,
  contextWindow: number | undefined,
): boolean {
  return message.stopReason !== 'stop' && isPiContextOverflow(message, contextWindow)
}

export function shouldDeferPiOverflowTerminalError(
  message: AssistantMessage | undefined,
  contextWindow: number | undefined,
  willRetry: boolean,
  abortRequested: boolean,
): boolean {
  return !willRetry && !abortRequested && !!message && shouldDeferPiOverflowTerminalMessage(message, contextWindow)
}

function installCurrentSessionCompactionHooks(session: AgentSession): void {
  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const previousResult = await previousBeforeToolCall?.(context, signal)
    if (previousResult?.block) return previousResult

    const toolNames = context.assistantMessage.content
      .filter((block) => block.type === 'toolCall')
      .map((block) => block.name)
    if (shouldBlockToolForAskUserQuestion(toolNames, context.toolCall.name)) {
      return {
        block: true,
        reason: 'AskUserQuestion 会暂停 Agent，不能与其他工具在同一批次执行。请在收到用户回答后再调用后续工具。',
      }
    }

    if (context.toolCall.name !== 'CompactContext') return previousResult
    if (canRunCurrentSessionCompaction(toolNames)) return previousResult

    // Pi only honors terminate when every tool in a batch is terminating. Rejecting
    // a mixed batch prevents more tool work or another model turn before compaction.
    return {
      block: true,
      reason: 'CompactContext 必须单独调用。请先完成当前工具批次，在下一回合仅调用 CompactContext。',
    }
  }
}

/**
 * Creates a session-scoped compaction control. The callback is closed over by one
 * query invocation, so a model cannot select or compact any other user session.
 */
export function buildCurrentSessionCompactionTool(
  sdk: PiSdk,
  requestCompaction: () => void,
  canUseTool: PiAgentQueryOptions['canUseTool'],
): ToolDefinition {
  const definition = sdk.defineTool({
    name: 'CompactContext',
    label: '压缩当前会话上下文',
    description: 'Compact only the current Pi Agent session after this turn finishes. Before calling, persist a durable handoff or checkpoint to the session workbench or project files as appropriate. Proma will compact the current session, then automatically continue the original task from the compacted context.',
    promptSnippet: 'CompactContext: after persisting a durable handoff/checkpoint, compact the current session context. Proma will automatically continue the original task after compaction.',
    parameters: Type.Object({}),
    async execute() {
      requestCompaction()
      return createTerminatingJsonToolResult({
        status: 'scheduled',
        message: '将在当前 Agent 回合安全结束后压缩当前会话上下文，并自动从已持久化的交接状态继续原始任务。',
      })
    },
  })

  return wrapToolWithPermission(
    definition as unknown as ToolDefinition<TSchema, unknown, unknown>,
    { canUseTool },
  ) as ToolDefinition
}

function isCompactionNoopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /nothing to compact|already compacted/i.test(message)
}

function createCompactionNoopMessage(sessionId: string, error: unknown): SDKMessage {
  const message = error instanceof Error ? error.message : String(error)
  return {
    type: 'system',
    subtype: 'status',
    session_id: sessionId,
    compact_result: 'noop',
    message: /already compacted/i.test(message)
      ? '当前上下文已经压缩过，无需重复压缩。'
      : '当前上下文较小，暂时无需压缩。',
  } as unknown as SDKMessage
}

export async function compactCurrentSessionAfterTurn(
  session: Pick<AgentSession, 'compact' | 'sessionId'>,
  onNoop: (message: SDKMessage) => void,
): Promise<'compacted' | 'noop'> {
  try {
    await session.compact()
    return 'compacted'
  } catch (error) {
    if (!isCompactionNoopError(error)) throw error
    onNoop(createCompactionNoopMessage(session.sessionId, error))
    return 'noop'
  }
}

function createCompactionContinuationLimitResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    terminal_reason: 'compaction_continuation_limit',
    errors: [`自动压缩续跑已达上限（${MAX_AUTOMATIC_COMPACTION_CONTINUATIONS} 次），任务未确认完成。请检查当前状态后继续。`],
    session_id: sessionId,
  } as unknown as SDKMessage
}

function buildPromaProductToolDefinitions(sdk: PiSdk, canUseTool: PiAgentQueryOptions['canUseTool']): ToolDefinition[] {

  const definitions = [
    sdk.defineTool({
      name: 'EnterPlanMode',
      label: '进入计划模式',
      description: '进入 Proma 计划模式。进入后只能调研、整理计划；将完整计划写入会话 plan/ 目录，并等待用户批准后再执行写操作。',
      promptSnippet: '进入计划模式，先调研，将完整计划写入 plan Markdown 文档，再等待用户确认。',
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: '进入计划模式的原因。' })),
      }),
      async execute(_toolCallId, params) {
        return createTextToolResult('已进入计划模式。', { active: true, input: params })
      },
    }),
    sdk.defineTool({
      name: 'ExitPlanMode',
      label: '提交计划审批',
      description: '向用户提交计划并请求批准。应传入 planFile 以便用户在右侧只读预览完整 Markdown 计划；用户批准后才能退出计划模式并继续执行。',
      promptSnippet: '提交计划审批：附上已写入 plan/ 目录的 Markdown 计划文件，等待用户批准后继续执行。',
      parameters: Type.Object({
        plan: Type.Optional(Type.String({ description: '计划正文或摘要。' })),
        planFile: Type.String({ description: '当前会话 plan/ 目录内、待审批的 Markdown 计划文件绝对路径（必填）。' }),
        allowedPrompts: Type.Optional(Type.Array(Type.Object({
          tool: Type.String({ description: '批准后可执行的工具，通常为 Bash。' }),
          prompt: Type.String({ description: '批准后可执行的命令或操作描述。' }),
        }))),
      }),
      async execute(_toolCallId, params) {
        return createTextToolResult('计划已获批准，可以继续执行。', { approved: true, input: params })
      },
    }),
    sdk.defineTool({
      name: 'AskUserQuestion',
      label: '询问用户',
      description: '当需要用户选择、补充信息或确认偏好时调用，Proma 会展示可交互问答横幅。',
      promptSnippet: '向用户提出结构化问题并等待回答。',
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ description: '要询问用户的问题。' }),
          header: Type.Optional(Type.String({ description: '简短标题。' })),
          multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选。' })),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String({ description: '选项标签。' }),
            description: Type.Optional(Type.String({ description: '选项说明。' })),
            preview: Type.Optional(Type.String({ description: '可选预览内容。' })),
          }))),
        })),
        answers: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        return createJsonToolResult({ answers: input.answers ?? {} })
      },
    }),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

const WSL_EXPORT_ENV_KEYS = [
  'PROMA_CLI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'PROMA_WINDOWS_SHELL',
  'PROMA_WSL_DISTRO',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`
}

export function windowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return value
  const drive = driveMatch[1]!.toLowerCase()
  const rest = driveMatch[2]!.replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

function buildWslCommand(command: string, env: NodeJS.ProcessEnv | undefined): string {
  const exportLines: string[] = []
  for (const key of WSL_EXPORT_ENV_KEYS) {
    const rawValue = env?.[key]
    if (!rawValue) continue
    const value = key === 'PROMA_CLI' ? windowsPathToWslPath(rawValue) : rawValue
    exportLines.push(`export ${key}=${shellQuote(value)}`)
  }

  return exportLines.length > 0
    ? `${exportLines.join('\n')}\n${command}`
    : command
}

export function buildWslBashArgs(
  runtimeEnv: Pick<AgentRuntimeEnv, 'wslDistro'>,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  return [
    ...(runtimeEnv.wslDistro ? ['--distribution', runtimeEnv.wslDistro] : []),
    '--cd',
    windowsPathToWslPath(cwd),
    '--exec',
    'bash',
    '-lc',
    buildWslCommand(command, env),
  ]
}

export function resolvePromaBashTimeoutSeconds(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_BASH_TIMEOUT_SECONDS
  if (!Number.isFinite(requested) || requested <= 0) return requested
  return Math.min(requested, MAX_BASH_TIMEOUT_SECONDS)
}

function buildTaskkillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)]
}

/**
 * 官方 0.22.0：超时/取消时终止整个进程树。
 *
 * Windows 上只 kill 直接子进程会留下 wsl.exe 的子孙进程，必须 taskkill /T；
 * 其他平台优先杀进程组，失败再退回单进程。
 */
export function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        buildTaskkillArgs(pid),
        { stdio: 'ignore', detached: true, windowsHide: true },
      )
      killer.once('error', () => {})
      killer.unref()
    } catch {
      // taskkill 不可用时交给 fallback 计时器结算。
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程可能已经退出。
    }
  }
}

/**
 * 官方 0.22.0：Bash/PowerShell 未传 timeout 时补 300 秒默认值，
 * 显式值封顶 3600 秒，避免模型一句 `sleep` 让工具永久挂起。
 */
export function withPromaBashTimeout<T>(definition: T): T {
  const shellDefinition = definition as unknown as ToolDefinition<TSchema, unknown, unknown>
  return {
    ...shellDefinition,
    description: `${shellDefinition.description}

Timeouts: \`timeout\` is in seconds. When omitted it defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds; explicit values are capped at ${MAX_BASH_TIMEOUT_SECONDS} seconds. Pass a larger value for known long-running commands such as installs and full builds.`,
    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof shellDefinition.execute>[3],
      ctx: Parameters<typeof shellDefinition.execute>[4],
    ) {
      const input = (params ?? {}) as { timeout?: unknown }
      const requested = typeof input.timeout === 'number' ? input.timeout : undefined
      return shellDefinition.execute(
        toolCallId,
        { ...input, timeout: resolvePromaBashTimeoutSeconds(requested) } as unknown as Parameters<typeof shellDefinition.execute>[1],
        signal,
        onUpdate,
        ctx,
      )
    },
  } as unknown as T
}

function createWslBashOperations(runtimeEnv: AgentRuntimeEnv): BashOperations {
  return {
    exec(command, cwd, options) {
      return new Promise((resolve, reject) => {
        const mergedEnv = mergeRuntimeEnv(process.env, options.env)
        const args = buildWslBashArgs(runtimeEnv, cwd, command, mergedEnv)
        const child = spawn(runtimeEnv.wslCommand ?? 'wsl.exe', args, {
          env: mergedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let settled = false
        let timedOut = false
        let timeoutHandle: NodeJS.Timeout | undefined
        let fallbackHandle: NodeJS.Timeout | undefined

        const cleanup = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (fallbackHandle) clearTimeout(fallbackHandle)
          options.signal?.removeEventListener('abort', onAbort)
        }
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const killChild = (): void => {
          terminateProcessTree(child.pid)
        }
        // kill 之后 wsl.exe 可能不退出；超过宽限期直接以超时/取消结算。
        const scheduleFallback = (message: string): void => {
          if (fallbackHandle) return
          fallbackHandle = setTimeout(() => {
            settle(() => reject(new Error(message)))
          }, KILL_SETTLE_GRACE_MS)
        }
        const onAbort = (): void => {
          killChild()
          scheduleFallback('aborted')
        }

        if (options.signal?.aborted) {
          killChild()
          settle(() => reject(new Error('aborted')))
          return
        }

        child.stdout?.on('data', options.onData)
        child.stderr?.on('data', options.onData)
        child.on('error', (error) => {
          settle(() => reject(error))
        })
        child.on('close', (code) => {
          if (options.signal?.aborted) {
            settle(() => reject(new Error('aborted')))
          } else if (timedOut) {
            settle(() => reject(new Error(`timeout:${options.timeout}`)))
          } else {
            settle(() => resolve({ exitCode: code }))
          }
        })

        if (options.timeout !== undefined && options.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            killChild()
            scheduleFallback(`timeout:${options.timeout}`)
          }, options.timeout * 1000)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function createPromaBashToolOptions(runtimeEnv: AgentRuntimeEnv | undefined): BashToolOptions | undefined {
  if (!runtimeEnv) return undefined

  const spawnHook: NonNullable<BashToolOptions['spawnHook']> = ({ command, cwd, env }) => ({
    command,
    cwd,
    env: mergeRuntimeEnv(env, runtimeEnv.env),
  })

  if (runtimeEnv.shellKind === 'wsl') {
    return {
      operations: createWslBashOperations(runtimeEnv),
      spawnHook,
    }
  }

  return {
    ...(runtimeEnv.shellPath && { shellPath: runtimeEnv.shellPath }),
    spawnHook,
  }
}

export function isPiBashToolAvailable(
  platform: NodeJS.Platform,
  runtimeEnv: Pick<AgentRuntimeEnv, 'shellKind'> | undefined,
): boolean {
  // Pi 的 Windows Bash 工具只能通过 Proma 配置的 Git Bash 或 WSL 执行。
  return platform !== 'win32' || runtimeEnv?.shellKind === 'git-bash' || runtimeEnv?.shellKind === 'wsl'
}

/** Pi 0.84.3 起可在 Windows 无 Git Bash / WSL 时使用系统原生 PowerShell。 */
export function isPiPowerShellToolAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export type PiBuiltinShellTool = 'bash' | 'powershell' | 'none'

/** 每个会话只暴露一种 Shell，避免模型混用 Bash 与 PowerShell 语法。 */
export function selectPiBuiltinShellTool(
  platform: NodeJS.Platform,
  runtimeEnv: Pick<AgentRuntimeEnv, 'shellKind'> | undefined,
): PiBuiltinShellTool {
  if (isPiBashToolAvailable(platform, runtimeEnv)) return 'bash'
  if (isPiPowerShellToolAvailable(platform)) return 'powershell'
  return 'none'
}

function createPromaPowerShellToolOptions(runtimeEnv: AgentRuntimeEnv | undefined): PowerShellToolOptions | undefined {
  if (!runtimeEnv) return undefined
  return {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: mergeRuntimeEnv(env, runtimeEnv.env),
    }),
  }
}

function buildBuiltinToolDefinitions(
  sdk: PiSdk,
  cwd: string,
  canUseTool: PiAgentQueryOptions['canUseTool'],
  runtimeEnv: AgentRuntimeEnv | undefined,
  knowledgeMutationObserver: KnowledgeMutationObserver | undefined,
  imageResizeOptions: ModelImageResizeOptions,
): ToolDefinition[] {
  const shellTool = selectPiBuiltinShellTool(process.platform, runtimeEnv)
  const editTool = knowledgeMutationObserver
    ? createKnowledgeAwareFileTool(sdk, cwd, 'edit', knowledgeMutationObserver)
    : sdk.createEditToolDefinition(cwd)
  const writeTool = knowledgeMutationObserver
    ? createKnowledgeAwareFileTool(sdk, cwd, 'write', knowledgeMutationObserver)
    : sdk.createWriteToolDefinition(cwd)
  const definitions = [
    sdk.createReadToolDefinition(cwd, { resizeOptions: imageResizeOptions }),
    ...(shellTool === 'bash'
      ? [withPromaBashTimeout(sdk.createBashToolDefinition(cwd, createPromaBashToolOptions(runtimeEnv)))]
      : []),
    ...(shellTool === 'powershell'
      ? [withPromaBashTimeout(sdk.createPowerShellToolDefinition(cwd, createPromaPowerShellToolOptions(runtimeEnv)))]
      : []),
    editTool,
    writeTool,
    sdk.createGrepToolDefinition(cwd),
    sdk.createFindToolDefinition(cwd),
    sdk.createLsToolDefinition(cwd),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

/**
 * 按当前平台与 shell 工具给系统提示追加固有能力声明。
 *
 * `platform` 可注入：调用点不传（用 `process.platform`），测试里传 `'win32'`
 * 就能在非 Windows CI 上验证 Windows 专属分支 —— 否则这段提示永远覆盖不到。
 */
export function appendWindowsBaseModeInstruction(
  systemPrompt: string,
  runtimeEnv: AgentRuntimeEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const shellTool = selectPiBuiltinShellTool(platform, runtimeEnv)
  if (platform !== 'win32') {
    return systemPrompt
  }

  // Windows + Bash 工具：说清它是 **Git Bash**，不是 cmd.exe / PowerShell。
  // 不说这句时，模型很容易把 cmd 的 `cd /d`、`dir /b`、`%VAR%` 当成通用写法 ——
  // bash 会报 `cd: too many arguments`，而失败引导只能事后纠偏（多花一轮）。
  // 这里把约束前置。实测（2026-10-16）的失败就是这一类。
  if (shellTool === 'bash') {
    const shellName = runtimeEnv?.shellKind === 'wsl' ? 'WSL 里的 Linux bash' : 'Git Bash'
    return `${systemPrompt}

<runtime_capabilities>
Windows 上的 Bash 工具由 **${shellName}** 执行，不是 cmd.exe、也不是 PowerShell。写命令时一律用 bash 语法：
- 切目录用 cd "D:/路径"（bash 的 cd 没有 /d 开关；路径含空格必须加引号），不要写 cd /d。
- 列目录用 ls、ls -A，不要写 dir 或 dir /b（dir /b 是 cmd.exe 的开关，bash 不认）。
- 环境变量用 $VAR，不要写 %VAR%；反斜杠在 bash 里是转义符，Windows 路径优先用正斜杠 / 或加引号。
- 命令链可以用 && 、|| 、; ，但做存在性 / 信息性探测时不要把可选步骤串在必须成功的 && 链上 —— 那种失败只会让整条命令带非零退出码。
- 「Command exited with code N」只说明链上某一步返回了非零，不代表环境或工具坏了：先读输出确认是哪一步、那一步是否必须成功。
</runtime_capabilities>`
  }

  if (shellTool === 'powershell') {
    return `${systemPrompt}

<runtime_capabilities>
当前 Windows 设备未配置 Git Bash 或 WSL，因此 Bash 工具不可用；已启用原生 PowerShell 工具。需要运行命令、测试或 Git 操作时，请使用 PowerShell 并采用 PowerShell 语法：Get-ChildItem 而不是 dir /b、Set-Location 而不是 cd /d、$env:VAR 而不是 %VAR%；&& 只在 PowerShell 7+ 可用。不要调用 InstallWindowsShell。
</runtime_capabilities>`
  }

  return `${systemPrompt}

<runtime_capabilities>
当前 Windows 设备未配置 Git Bash 或 WSL，因此 Bash 工具不可用。你仍可使用 Read、Write、Edit、Grep、Find、Ls 及 Proma 提供的其他工具完成任务；不要声称已运行命令、测试或 Git 操作。若任务确实需要命令行，请默认调用 InstallWindowsShell 帮助用户安装 Git Bash；该工具会要求用户确认下载并打开官方安装程序。
</runtime_capabilities>`
}

function wrapCustomToolDefinitions(
  tools: ToolDefinition[] | undefined,
  canUseTool: PiAgentQueryOptions['canUseTool'],
): ToolDefinition[] {
  return (tools ?? []).map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

export function installRuntimeGuardHooks(session: AgentSession, guard: AgentRuntimeGuard): void {
  const previousAfterToolCall = session.agent.afterToolCall
  session.agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal)
    const resultAfterPreviousHooks = {
      content: previousResult?.content ?? context.result.content,
      details: previousResult?.details ?? context.result.details,
      terminate: previousResult?.terminate ?? context.result.terminate,
    }
    const sanitizedContent = sanitizeToolResultImageContent(resultAfterPreviousHooks.content)
    const guardedResult = guard.applyToolResult({
      ...resultAfterPreviousHooks,
      content: sanitizedContent,
    })

    if (
      !previousResult
      && guardedResult.terminate === context.result.terminate
      && sanitizedContent === context.result.content
    ) {
      return undefined
    }

    return {
      ...previousResult,
      content: sanitizedContent,
      details: normalizePiToolResultDetails(resultAfterPreviousHooks.details),
      terminate: guardedResult.terminate,
    }
  }

  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
  session.agent.prepareNextTurnWithContext = async (context, signal) => {
    const previousSnapshot = await previousPrepareNextTurnWithContext?.(context, signal)
    if (guard.shouldStopBeforeNextTurn()) {
      // Pi 的 steer/follow-up 队列在 turn 完成后才 drain；达到 Proma 上限时必须在这里清空，
      // 否则纯文本 turn 之后追加的队列消息会绕过 afterToolCall 继续进入下一轮。
      session.agent.clearAllQueues()
    }
    return previousSnapshot
  }
}

export function installToolFailureGuidanceHooks(session: AgentSession): void {
  const previousAfterToolCall = session.agent.afterToolCall
  session.agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal)
    const content = previousResult?.content ?? context.result.content
    const guidance = buildPiToolFailureGuidance(
      context.toolCall.name,
      previousResult?.isError ?? context.isError,
      content,
    )
    if (!guidance) return previousResult

    return {
      ...previousResult,
      content: [...content, { type: 'text', text: guidance }],
    }
  }
}

export class PiAgentAdapter implements AgentProviderAdapter {
  private activeSessions = new Map<string, ActivePiSession>()

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const active = createActivePiSession()
    this.activeSessions.set(input.sessionId, active)
    const queue = createAsyncQueue<SDKMessage>()
    const runtimeGuard = createAgentRuntimeGuard(input)
    // 同一 session 的新请求可能在旧 IPC 事件之后开始；所有 retry 生命周期均携带这一轮标识。
    const retryRunStartedAt = input.retryRunStartedAt ?? Date.now()
    active.runtimeGuard = runtimeGuard
    active.skillWorkspaceSlug = input.skillWorkspaceSlug
    active.onSkillActivated = input.onSkillActivated
    let unsubscribe: (() => void) | undefined
    let detachInterruptedOutputNotes: (() => void) | undefined
    let requestProxyDispatcher: Dispatcher | undefined

    let producerTask: Promise<void> | undefined
    let producerSettled = false
    const cleanupActiveSession = createPiSessionCleanup({
      waitForProducer: async () => {
        // 提前 return 时先中止本会话，再等待不含 cleanup 的 producer，避免相互等待。
        if (!producerSettled && active.session) {
          active.abortRequested = true
          active.abortController.abort()
          rejectPendingInterruptPrompts(active, createAbortError())
          active.session.abortCompaction()
          await active.session.abort().catch(() => {})
        }
        await producerTask
      },
      dispose: () => {
        unsubscribe?.()
        unsubscribe = undefined
        detachInterruptedOutputNotes?.()
        detachInterruptedOutputNotes = undefined
        if (!active.disposed) {
          active.disposed = true
          active.abortController.abort()
          rejectPendingInterruptPrompts(active, createAbortError())
          active.pendingSkillActivations.clear()
          active.session?.dispose()
        }
      },
      closeDispatcher: async () => {
        await closePiRequestProxyDispatcher(requestProxyDispatcher, { strict: true })
        requestProxyDispatcher = undefined
      },
      release: () => {
        if (this.activeSessions.get(input.sessionId) === active) this.activeSessions.delete(input.sessionId)
      },
    })

    try {
      installPiRequestProxyFetch()
      const piHttpProxy = resolvePiHttpProxy(input)
      requestProxyDispatcher = createPiRequestProxyDispatcher({
        proxyUrl: piHttpProxy,
        noProxy: getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'NO_PROXY'),
        httpIdleTimeoutMs: input.httpIdleTimeoutMs,
      })
      const sdk = await import('@earendil-works/pi-coding-agent')
      // 速度档按「显式 codexSpeed > 旧 codexFastMode > standard」解析，并在模型不支持时回退。
      const codexSpeed = resolveCodexSpeed(input, input.model)
      const piAi = codexSpeed !== 'standard' && input.provider === 'openai-codex'
        ? await import('@earendil-works/pi-ai/compat')
        : undefined
      if (active.abortRequested) throw createAbortError()

      if (!existsSync(input.piSessionDir)) mkdirSync(input.piSessionDir, { recursive: true })
      const cwd = input.cwd ?? process.cwd()
      const sessionFile = input.resumeSessionId ? findSessionFile(input.piSessionDir, input.resumeSessionId) : undefined
      if (input.resumeSessionId && !sessionFile) {
        throw new Error(`No conversation found with session ID ${input.resumeSessionId}`)
      }
      const sessionManager = sessionFile
        ? sdk.SessionManager.open(sessionFile, input.piSessionDir, cwd)
        : sdk.SessionManager.create(cwd, input.piSessionDir)
      const { modelRuntime, model: builtModel } = await buildModel(sdk, input)
      // 与官方一致：把图片上限并入模型定义，由 Pi 在图片进入会话时压缩一次。
      const model = withPromaImageInputLimits(builtModel)
      const autoCompactionReserveTokens = calculatePiAutoCompactionReserveTokens(
        model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      )
      let compactContextRequested = false
      let pendingCompactionContinuation: string | undefined
      let automaticCompactionContinuations = 0
      let pendingTerminalResult: SDKMessage | undefined
      /** 当前压缩是否紧随一个成功完成的主 Agent turn。 */
      let completedAgentTurnPendingCompaction = false
      const customTools = [
        buildCurrentSessionCompactionTool(
          sdk,
          () => { compactContextRequested = true },
          input.canUseTool,
        ),
        ...buildBuiltinToolDefinitions(
          sdk,
          cwd,
          input.canUseTool,
          input.runtimeEnv,
          input.knowledgeMutationObserver,
          model.inputLimits?.images?.resize ?? MODEL_IMAGE_RESIZE_OPTIONS,
        ),
        ...buildPromaProductToolDefinitions(sdk, input.canUseTool),
        ...wrapCustomToolDefinitions(input.customTools, input.canUseTool),
      ]

      const settingsManager = sdk.SettingsManager.inMemory({
        // 使用 Pi SDK 原生压缩策略：
        // - 手动压缩由 session.compact() 触发；
        // - 自动压缩在上下文达到模型窗口的约 80% 时触发；Pi 以 reserveTokens 表示预留空间。
        compaction: { enabled: true, reserveTokens: autoCompactionReserveTokens },
        // Pi 原生 retry 通过 agent.continue() 在同一 transcript 中恢复，能保留已完成的
        // tool_result；不能用外层重投原始 prompt 替代，否则会重复执行副作用工具。
        retry: {
          enabled: true,
          maxRetries: PI_NATIVE_MAX_RETRIES,
          baseDelayMs: PI_NATIVE_RETRY_BASE_DELAY_MS,
          maxAgentDelayMs: PI_NATIVE_MAX_DELAY_MS,
        },
        // Cache warming 会额外发送 provider 请求；在提供显式开关前不应静默增加消耗。
        cacheWarming: 'off',
        ...buildPiRemoteConnectionSettings(input),
      })
      const reasoningProfile = resolveReasoningProfile({
        modelId: model.id,
        transport: toReasoningTransport(model.api),
        profiles: input.reasoningProfiles,
      })
      const thinkingLevel = model.reasoning === false
        ? 'off'
        : normalizeReasoningLevel(reasoningProfile, input.thinkingLevel) ?? 'off'
      const openAIReasoningProfile = toReasoningTransport(model.api) === 'openai-responses' ? reasoningProfile : undefined
      const deepSeekReasoningProfile = model.api === 'anthropic-messages' ? reasoningProfile : undefined
      const projectInstructionScope = input.projectInstructionScope
        ? new ProjectInstructionScopeController({
            projectRoot: input.projectInstructionScope.projectRoot,
            cwd,
            initialSources: input.projectInstructionScope.initialSources,
            sessionState: createProjectScopeState(sessionManager),
          })
        : undefined
      const collaborationBoundary = input.onCollaborationBoundary
        ? createPiCollaborationBoundary({
            boundary: input.onCollaborationBoundary,
            signal: () => active.abortController.signal,
            canContinue: () => !active.abortRequested && !active.disposed,
          })
        : undefined
      const extensionFactories = [
        ...(collaborationBoundary ? [collaborationBoundary.extension] : []),
        ...(projectInstructionScope ? [projectInstructionScope.createExtension()] : []),
        // 破甲联动：仅破甲开启且未显式关闭时才挂 Seep 的三层管线。
        // provider 层（Google safetySettings）与 input/context 层各自独立，
        // 便于用户只关掉其中一半而不影响另一半。
        ...(input.seepProviderSafety ? [createSeepProviderSafetyExtension()] : []),
        ...(input.seepInputPipeline ? [createSeepInputPipelineExtension()] : []),
        ...(openAIReasoningProfile
          ? [createOpenAIReasoningRequestExtension({
              profile: openAIReasoningProfile,
              thinkingLevel,
            })]
          : []),
        ...(deepSeekReasoningProfile?.encodings['anthropic-messages']?.kind === 'deepseek-output-effort'
          ? [createDeepSeekReasoningRequestExtension({
              profile: deepSeekReasoningProfile,
              thinkingLevel,
            })]
          : []),
        ...(input.provider === 'kimi-api' || input.provider === 'kimi-coding'
          ? [createKimiRequestExtension({
              provider: input.provider,
              profile: reasoningProfile,
              thinkingLevel,
            })]
          : []),
        ...(input.provider === 'doubao-api'
          ? [createVolcengineReasoningRequestExtension({ thinkingLevel })]
          : []),
        ...(input.provider === 'openai-codex' && codexSpeed !== 'standard'
          ? [createCodexSpeedExtension({ speed: codexSpeed })]
          : []),
      ]
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: input.piAgentDir,
        settingsManager,
        ...createPromaManagedResourceLoaderOptions(),
        agentsFilesOverride: createPromaProjectInstructionFilesOverride(input.projectInstructionFiles ?? []),
        additionalSkillPaths: input.additionalSkillPaths ?? [],
        skillsOverride: createPromaSkillsOverride(input.additionalSkillPaths),
        ...(extensionFactories.length > 0 && { extensionFactories }),
        systemPromptOverride: () => appendWindowsBaseModeInstruction(input.systemPrompt, input.runtimeEnv),
      })
      await resourceLoader.reload()
      active.resourceLoader = resourceLoader

      const skillDiagnostics = resourceLoader.getSkills().diagnostics
      for (const diagnostic of skillDiagnostics) {
        const level = diagnostic.type === 'error' ? 'error' : 'warn'
        console[level](`[Pi SDK] Skill 加载诊断: ${diagnostic.path ?? '(unknown)'} ${diagnostic.message}`)
      }

      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: input.piAgentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager,
        model,
        thinkingLevel,
        noTools: 'builtin',
        customTools,
      })
      if (collaborationBoundary) {
        session.extensionRunner.onError((error: unknown) => {
          collaborationBoundary.captureError(error as { extensionPath?: unknown; event?: unknown; error?: unknown })
        })
      }
      session.agent.toolExecution = 'sequential'
      // Pi 原生 retry 只认少量通用文案；覆盖后与 Proma 的账单/网络/流中断分类保持一致。
      if (!installPromaRetryClassifier(session)) {
        console.warn('[Pi SDK] 未找到 _isRetryableError，Proma 网络重试分类未生效；请检查 Pi 版本兼容性')
      }
      // 官方 0.22.0：默认只回传最后一轮的签名 thinking；opaque 400/签名不兼容后按会话强制剥离。
      const thinkingReplay = createThinkingReplayState(
        consumeThinkingStripForSession(input.sessionId) ? 'none' : resolveThinkingReplayMode() ?? 'turn',
      )
      // 图片压缩交给 Pi（见 withPromaImageInputLimits）；这里只做两件事：
      // 1) 按业务轮次边界做请求图片预算（官方无此能力）；2) 项目指令作用域投影。
      const imageRequestBudget = createAgentImageRequestBudget()
      const previousTransformContext = session.agent.transformContext
      session.agent.transformContext = async (messages, signal) => {
        const current = await previousTransformContext?.(messages, signal) ?? messages
        const budgeted = await imageRequestBudget.project(current, PI_COMPACTION_CONTINUATION_PROMPT, signal)
        const projected = projectInstructionScope?.projectContext(budgeted, signal) ?? budgeted
        // 官方 0.22.0：每轮重新读取记忆并替换 proma_memory section；project_context 同步保留。
        let withMemory = projected
        if (input.memoryContext) {
          try {
            withMemory = refreshMemorySystemMessages(
              projected,
              input.memoryContext,
              input.projectInstructionFiles ?? [],
              input.retryRunStartedAt,
            )
          } catch (error) {
            console.warn('[Pi SDK] 记忆上下文刷新失败，本轮跳过:', error)
          }
        }
        const replayed = applyThinkingReplayPolicy(withMemory, thinkingReplay, {
          supported: model.api === 'anthropic-messages',
        })
        recordPrefixFingerprint(thinkingReplay, buildPrefixFingerprint(replayed))
        if (thinkingReplay.mode === 'none') {
          const latest = thinkingReplay.fingerprints[thinkingReplay.fingerprints.length - 1]
          console.log(
            `[Pi SDK] thinking replay 诊断 | mode=${thinkingReplay.mode} | request=${thinkingReplay.fingerprints.length} | msgs=${latest?.messageCount} | signedThinking=${latest?.signedThinkingCount} | ${describePrefixDrift(thinkingReplay)}`,
          )
        }
        return replayed
      }
      if (piAi && codexSpeed !== 'standard' && input.provider === 'openai-codex' && isCodexSpeedSupportedModel(codexSpeed, input.model)) {
        // Pi 的通用 streamSimple 会丢弃 provider 专属 serviceTier；这里直接走
        // provider stream，确保 request body 与 usage.cost 都使用 priority tier。
        session.agent.streamFunction = async (requestModel, context, options) => {
          const authResult = await modelRuntime.getAuth(requestModel)
          if (!authResult?.auth.apiKey) throw new Error('无法获取 ChatGPT (Codex) OAuth access token')
          const auth = authResult.auth

          const env = authResult.env || options?.env ? { ...(authResult.env ?? {}), ...(options?.env ?? {}) } : undefined
          const retrySettings = settingsManager.getProviderRetrySettings()
          const configuredTimeoutMs = settingsManager.getHttpIdleTimeoutMs()
          const timeoutMs = options?.timeoutMs ?? retrySettings.timeoutMs ?? (configuredTimeoutMs === 0 ? 2_147_483_647 : configuredTimeoutMs)
          const websocketConnectTimeoutMs = options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs()

          return piAi.stream(requestModel, context, withCodexServiceTier({
            ...options,
            apiKey: auth.apiKey,
            env,
            timeoutMs,
            websocketConnectTimeoutMs,
            maxRetries: options?.maxRetries ?? retrySettings.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs ?? retrySettings.maxRetryDelayMs,
            headers: { ...auth.headers, ...options?.headers },
          }, codexSpeed))
        }
      }
      // 代理作用域必须只覆盖模型 provider stream：在整个 session.prompt() 链上设
      // AsyncLocalStorage 会把 MCP/产品工具等同一 Agent loop 中的 fetch 也错误地送进 Codex 代理。
      const providerStreamFn = session.agent.streamFunction
      session.agent.streamFunction = await withPiStreamFinalizationGuard(async (requestModel, context, options) => {
        // 明确配置了渠道/环境代理时保持现有 undici dispatcher 路径；
        // 纯直连请求交给系统网络 fetch（系统代理、路由切换与诊断）。
        if (piHttpProxy) {
          const proxyResult = runWithPiRequestProxy(
            requestProxyDispatcher,
            () => providerStreamFn(requestModel, context, options),
          )
          return await proxyResult
        }
        const systemNetwork = await resolvePiModelSystemNetwork()
        const systemResult = await runWithPiSystemNetwork(
          systemNetwork,
          async () => await providerStreamFn(requestModel, context, options),
        )
        return await systemResult
      })
      installRuntimeGuardHooks(session, runtimeGuard)
      installToolFailureGuidanceHooks(session)
      installCurrentSessionCompactionHooks(session)
      active.session = session
      resolveActiveReady(active, session)

      if (active.abortRequested) {
        await session.abort().catch(() => {})
        throw createAbortError()
      }

      input.onSessionId?.(session.sessionId, session.sessionFile)
      input.onModelResolved?.(session.model?.id ?? input.model ?? 'default')
      input.onContextWindow?.(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW)

      queue.push({
        type: 'system',
        subtype: 'init',
        session_id: session.sessionId,
        model: session.model?.id ?? input.model,
      } as unknown as SDKMessage)

      const assistantUuidTracker = createPiAssistantUuidTracker()
      // Pi 会在 native retry 前先发出 error assistant，再以 agent_end.willRetry 标记。
      // 延迟向 orchestrator 透传该 error，避免它先触发外层重试而重放整个 prompt。
      const retryTerminalGate = createPiRetryTerminalGate<{
        assistantMessage: AssistantMessage
        sdkMessage: SDKMessage
        assistantUuid: string
      }>()
      let pendingNativeOverflowRecovery = false
      // message_end 发生在 Pi 落盘前；保留对象身份，待 prompt 完成后从
      // SessionManager entries 精确取得 Pi entry ID，绝不按文本猜测。
      const finalAssistantUuids = new Map<AssistantMessage, string>()

      const persistPiEntryBindings = (): void => {
        const bindings: Record<string, string> = {}
        for (const entry of sessionManager.getEntries()) {
          if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
          const uuid = finalAssistantUuids.get(entry.message as AssistantMessage)
          if (uuid) bindings[uuid] = entry.id
        }
        if (Object.keys(bindings).length > 0) input.onPiEntryBindings?.(bindings)
      }

      const assistantUuidFor = (): string => assistantUuidTracker.get()
      const resetAssistantStream = (): void => {
        assistantUuidTracker.reset()
      }

      // 每条 assistant 消息的 TTFT / 解码耗时：状态栏输出速度按解码耗时算分母，
      // 把首 token 等待排除在外。message_end 时收束并挂到 SDK 消息上。
      const responseTiming = createPiResponseTimingTracker()

      /** 把实测计时挂到 assistant SDK 消息上；无计时时原样返回。 */
      const withResponseTiming = (
        message: SDKMessage,
        timing: PiResponseTiming,
      ): SDKMessage => {
        if (timing.ttftMs === undefined && timing.decodeMs === undefined) return message
        return {
          ...message,
          ...(timing.ttftMs !== undefined && { _ttftMs: timing.ttftMs }),
          ...(timing.decodeMs !== undefined && { _decodeMs: timing.decodeMs }),
        } as SDKMessage
      }

      /**
       * 收束一条 assistant 消息的计时。
       *
       * 优先用自己测的增量窗口；没有增量（非流式响应、或本次运行没收到
       * message_update）时退回 Pi 自带的 durationMs——它覆盖整个响应流，
       * 含排队与首 token 等待，速度会偏低，但总比让状态栏一片空白好。
       */
      const finishResponseTiming = (
        uuid: string,
        assistant: AssistantMessage,
      ): PiResponseTiming => {
        const measured = responseTiming.finish(uuid, Date.now())
        if (measured.decodeMs !== undefined) return measured
        const piDuration = assistant.durationMs
        if (typeof piDuration === 'number' && Number.isFinite(piDuration) && piDuration > 0) {
          return { ...measured, decodeMs: piDuration }
        }
        return measured
      }

      const emitTerminalRetryError = (terminalRetryError: {
        assistantMessage: AssistantMessage
        sdkMessage: SDKMessage
        assistantUuid: string
      }): void => {
        finalAssistantUuids.set(terminalRetryError.assistantMessage, terminalRetryError.assistantUuid)
        runtimeGuard.recordMessage(terminalRetryError.assistantMessage)
        queue.push(terminalRetryError.sdkMessage)
        resetAssistantStream()
      }

      detachInterruptedOutputNotes = attachInterruptedOutputNotes(session)
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
          switch (event.type) {
            case 'message_start': {
              const prompt = getPiUserMessageText(event.message)
              if (!prompt) break
              const pending = active.pendingSkillActivations.consume(prompt)
              if (pending) active.onSkillActivated?.(pending.activations, pending.userMessageUuid)
              break
            }
            case 'message_update': {
              if (!isAssistantPiMessage(event.message)) break
              const assistantUuid = assistantUuidFor()
              const delta = serializePiAssistantDelta(event.assistantMessageEvent)
              if (delta) {
                // 只统计真正的增量：start/text_start 等控制帧不算首 token。
                if (delta.type === 'text_delta' || delta.type === 'thinking_delta' || delta.type === 'toolcall_delta') {
                  responseTiming.noteDelta(assistantUuid, event.message.timestamp, Date.now())
                }
                queue.push({
                  type: 'assistant_delta',
                  uuid: assistantUuid,
                  delta,
                  session_id: session.sessionId,
                  ...(input.model && { _channelModelId: input.model }),
                } as unknown as SDKMessage)
              }
              break
            }
            case 'message_end': {
              if (active.interrupting && isAbortedAssistantMessage(event.message)) {
                const abortedUuid = assistantUuidFor()
                const timing = finishResponseTiming(abortedUuid, event.message as AssistantMessage)
                const converted = convertPiMessage(event.message, session.sessionId, input.model, {
                  uuid: abortedUuid,
                })
                if (converted?.type === 'assistant') queue.push(withResponseTiming(converted, timing))
                resetAssistantStream()
                break
              }
              const isAssistant = isAssistantPiMessage(event.message)
              const assistantUuid = isAssistant ? assistantUuidFor() : undefined
              const converted = convertPiMessage(event.message, session.sessionId, input.model, {
                ...(assistantUuid && { uuid: assistantUuid }),
              })
              const timing = assistantUuid && isAssistant
                ? finishResponseTiming(assistantUuid, event.message as AssistantMessage)
                : {}
              const timedConverted = converted?.type === 'assistant'
                ? withResponseTiming(converted, timing)
                : converted
              const shouldDeferNativeOverflow = isAssistant
                && shouldDeferPiOverflowTerminalMessage(event.message as AssistantMessage, model.contextWindow)
              const shouldDeferAssistantTerminal = isAssistant && (
                (event.message as AssistantMessage).stopReason === 'error' || shouldDeferNativeOverflow
              )
              if (shouldDeferAssistantTerminal && timedConverted?.type === 'assistant' && assistantUuid) {
                // Native retry 会丢弃该失败 assistant；不应消耗 Proma 的 turn/budget 配额。
                // 关键：此处不能重置 UUID。retry 后的新 partial/final 必须原地替换此前
                // 已经展示的 partial，避免用户同时看到断流残片和恢复后的完整回答。
                retryTerminalGate.defer({
                  assistantMessage: event.message as AssistantMessage,
                  sdkMessage: timedConverted,
                  assistantUuid,
                })
              } else {
                runtimeGuard.recordMessage(event.message)
                if (timedConverted && (timedConverted.type !== 'user' || hasToolResult(timedConverted))) {
                  queue.push(timedConverted)
                }
                if (isAssistant && assistantUuid) {
                  finalAssistantUuids.set(event.message as AssistantMessage, assistantUuid)
                  resetAssistantStream()
                }
              }
              break
            }
            case 'agent_end':
              completedAgentTurnPendingCompaction = false
              if (active.abortRequested || (active.interrupting && active.pendingInterruptPrompts.length > 0)) {
                // 用户停止或插入新 prompt 时，当前 loop 的错误与 result 都不得泄漏到下一轮。
                retryTerminalGate.settle(true)
                pendingNativeOverflowRecovery = false
                pendingTerminalResult = undefined
                resetAssistantStream()
                responseTiming.reset()
                break
              }
              const deferredRetryError = retryTerminalGate.peek()
              const waitsForNativeOverflowRecovery = shouldDeferPiOverflowTerminalError(
                deferredRetryError?.assistantMessage,
                model.contextWindow,
                event.willRetry,
                active.abortRequested,
              )
              // Pi 在 agent_end 后才会检测 overflow 并压缩。此时若先将错误交给
              // orchestrator，会触发外层恢复或清理，打断同 transcript 的 continue。
              const terminalRetryError = waitsForNativeOverflowRecovery
                ? undefined
                : retryTerminalGate.settle(event.willRetry)
              if (waitsForNativeOverflowRecovery) pendingNativeOverflowRecovery = true
              if (event.willRetry) {
                // native retry 会在同一 session 中调用 continue()，不要向上游发送终态，
                // 并保留当前 UUID，供恢复后的输出替换此前 partial。
                // 计时必须一并丢弃：重试后的首 token 到达时刻要重新定锚，
                // 否则沿用失败那次的锚点会算出虚高的解码耗时、把速度压低。
                responseTiming.forget(assistantUuidFor())
                break
              }
              if (terminalRetryError) {
                emitTerminalRetryError(terminalRetryError)
              }
              // Pi can start auto-compaction after agent_end but before session.prompt()
              // resolves. Defer the terminal result until then, otherwise the orchestrator's
              // result-drain timeout may dispose the session and abort compaction.
              const terminalResult = convertResultMessage(
                event.messages,
                session.sessionId,
                runtimeGuard.getResultOverride(event.messages),
              )
              pendingTerminalResult = terminalResult
              completedAgentTurnPendingCompaction = shouldMarkCompactionAfterCompletedTurn(
                terminalResult,
                compactContextRequested,
              )
              break
            case 'auto_retry_start':
            case 'auto_retry_end':
              for (const retry of mapPiNativeRetryEvent(event, { runStartedAt: retryRunStartedAt })) input.onRetry?.(retry)
              break
            case 'tool_execution_update':
              queue.push({
                type: 'tool_progress',
                session_id: session.sessionId,
                tool_use_id: event.toolCallId,
                tool_name: displayToolName(event.toolName, event.args as Record<string, unknown> | undefined),
                parent_tool_use_id: null,
              } as unknown as SDKMessage)
              break
            case 'compaction_start': {
              const afterCompletedTurn = completedAgentTurnPendingCompaction
              completedAgentTurnPendingCompaction = false
              // 压缩开始（手动 /compact 或自动阈值/溢出触发）：发前端已识别的 compacting system 消息，
              // 展示「正在压缩上下文...」分隔符。此前迁移遗漏了该事件，导致自动压缩与手动压缩都无 UI。
              // 只有成功完成主 turn 后才进入可验收完成态；运行中压缩仍保持 running。
              queue.push({
                type: 'system',
                subtype: 'compacting',
                session_id: session.sessionId,
                afterCompletedTurn,
              } as unknown as SDKMessage)
              break
            }
            case 'compaction_end':
              if (pendingNativeOverflowRecovery && event.reason === 'overflow') {
                pendingNativeOverflowRecovery = false
                const recovered = !event.aborted && event.result !== undefined && event.willRetry
                const terminalRetryError = retryTerminalGate.settle(
                  recovered || active.abortRequested || active.interrupting,
                )
                if (terminalRetryError) emitTerminalRetryError(terminalRetryError)
              }
              // 所有压缩结果都必须有可识别的终态，确保 renderer 能结束底部进度追踪。
              if (!event.aborted && event.result) {
                queue.push({
                  type: 'system',
                  subtype: 'compact_boundary',
                  session_id: session.sessionId,
                  summary: event.result.summary,
                  // 仅手动压缩展示 Pi 的压缩后预估值，自动压缩保持既有行为。
                  ...(event.reason === 'manual' && event.result.estimatedTokensAfter != null && {
                    compactionEstimatedTokensAfter: event.result.estimatedTokensAfter,
                  }),
                } as unknown as SDKMessage)
              } else if (event.aborted) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: '上下文压缩已取消。',
                } as unknown as SDKMessage)
              } else if (event.errorMessage && !isCompactionNoopError(event.errorMessage)) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: event.errorMessage,
                } as unknown as SDKMessage)
              }
              break
            case 'agent_settled':
              // 防御上游缺少 compaction_end 的异常事件序列，不能无限吞掉已 deferred 的错误。
              if (pendingNativeOverflowRecovery) {
                pendingNativeOverflowRecovery = false
                const terminalRetryError = retryTerminalGate.settle(active.abortRequested || active.interrupting)
                if (terminalRetryError) emitTerminalRetryError(terminalRetryError)
              }
              break
          }
        } catch (error) {
          queue.fail(error)
        }
      })

      if (input.compactRequest) {
        // 手动压缩：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型。
        // compaction_start/end 事件已在上面的 subscribe 中转成 compacting/compact_boundary system 消息；
        // compact() 不发 agent_end，故这里补一个合成 result 消息收束本轮（供 orchestrator 结束消费循环）。
        producerTask = session.compact()
          .then(() => {
            producerSettled = true
            queue.push({
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              terminal_reason: 'completed',
              isSyntheticCompactionResult: true,
              session_id: session.sessionId,
            } as unknown as SDKMessage)
            queue.close()
          })
          .catch((error) => {
            producerSettled = true
            // 「会话太小无需压缩」/「已压缩」是良性情况，不是执行错误：
            // pi 会抛 "Nothing to compact (session too small)" / "Already compacted"。
            // 这里不 fail 队列（否则前端弹通用「执行错误」），改为正常收尾并给出友好提示。
            if (isCompactionNoopError(error)) {
              queue.push(createCompactionNoopMessage(session.sessionId, error))
              queue.push({
                type: 'result',
                subtype: 'success',
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                terminal_reason: 'completed',
                isSyntheticCompactionResult: true,
                session_id: session.sessionId,
              } as unknown as SDKMessage)
              queue.close()
            } else {
              queue.fail(error)
            }
          })
      } else {
        const runPromptChain = async (): Promise<void> => {
          let nextPrompt: {
            content: string
            skipSkillExpansion: boolean
            skillMentions?: string[]
            userMessageUuid?: string
          } | undefined = {
            content: appendOutputFormatInstruction(input.prompt, input.outputFormat),
            skipSkillExpansion: false,
            skillMentions: input.skillMentions,
            userMessageUuid: input.initialUserMessageUuid,
          }
          let nextInterrupt: PendingInterruptPrompt | undefined
          while (nextPrompt !== undefined) {
            const currentInterrupt = nextInterrupt
            nextInterrupt = undefined
            if (runtimeGuard.shouldStopBeforeNextTurn()) {
              currentInterrupt?.rejectAccepted(createAbortError())
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            const promptInput = nextPrompt
            let preparedPrompt: PreparedPromptWithSkills
            try {
              preparedPrompt = promptInput.skipSkillExpansion
                ? { content: promptInput.content, activations: [] }
                : await preparePromptWithPromaSkills(
                  resourceLoader,
                  promptInput.content,
                  promptInput.skillMentions,
                  input.skillWorkspaceSlug,
                )
            } catch (error) {
              currentInterrupt?.rejectAccepted(error)
              throw error
            }
            const prompt = preparedPrompt.content
            const skillActivationId = registerPromptSkillActivations(
              active,
              prompt,
              promptInput.userMessageUuid,
              preparedPrompt.activations,
            )
            nextPrompt = undefined
            try {
              if (active.abortRequested) {
                active.pendingSkillActivations.discard(skillActivationId)
                currentInterrupt?.rejectAccepted(createAbortError())
                rejectPendingInterruptPrompts(active, createAbortError())
                return
              }
              currentInterrupt?.resolveAccepted()
              await session.prompt(prompt, { source: 'rpc' })
              persistPiEntryBindings()
              if (compactContextRequested) {
                try {
                  await compactCurrentSessionAfterTurn(session, (message) => queue.push(message))
                } catch (error) {
                  // 用户在压缩期间停止时，Pi 会取消 summarization；这是正常中止而不是运行错误。
                  if (active.abortRequested) return
                  throw error
                }
                compactContextRequested = false
                const continuation = planPiCompactionContinuation({
                  continuationCount: automaticCompactionContinuations,
                  abortRequested: active.abortRequested,
                  runtimeLimitReached: runtimeGuard.shouldStopBeforeNextTurn(),
                })
                if (continuation.shouldContinue) {
                  automaticCompactionContinuations += 1
                  pendingCompactionContinuation = appendOutputFormatInstruction(continuation.prompt, input.outputFormat)
                  // 当前终态仅表示为执行压缩而结束的内部 loop，不应让上层把原任务视为完成。
                  pendingTerminalResult = undefined
                } else if (continuation.reason === 'continuation_limit') {
                  pendingTerminalResult = createCompactionContinuationLimitResult(session.sessionId)
                }
              }
              if (active.abortRequested || active.interrupting) {
                // Cancellation can arrive while Pi is compacting, after its first agent_end.
                // Do not render that stale terminal result before the next interrupt prompt starts.
                retryTerminalGate.settle(true)
                pendingNativeOverflowRecovery = false
                pendingTerminalResult = undefined
              } else if (pendingTerminalResult) {
                queue.push(pendingTerminalResult)
                pendingTerminalResult = undefined
              }
            } finally {
              if (active.interrupting) {
                session.agent.state.messages = dropTrailingAbortedAssistant(session.agent.state.messages)
              }
              active.interrupting = false
            }
            if (active.abortRequested) {
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            if (runtimeGuard.shouldStopBeforeNextTurn()) {
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            const pendingInterrupt = active.pendingInterruptPrompts.shift()
            nextInterrupt = pendingInterrupt
            if (pendingInterrupt) {
              nextPrompt = { content: pendingInterrupt.content, skipSkillExpansion: true }
            } else if (pendingCompactionContinuation) {
              nextPrompt = { content: pendingCompactionContinuation, skipSkillExpansion: true }
              pendingCompactionContinuation = undefined
            }
          }
        }

        producerTask = runPromptChain().then(
          () => { producerSettled = true; queue.close() },
          (error) => { producerSettled = true; queue.fail(error) },
        )
      }
      // 即使消费者提前退出，也与 iterator finally 共用同一清理屏障。
      void producerTask.then(cleanupActiveSession, cleanupActiveSession).catch(error => queue.fail(error))
    } catch (error) {
      rejectActiveReady(active, error)
      queue.fail(error)
    }

    try {
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      await cleanupActiveSession()
    }
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.abortRequested = true
    active.abortController.abort()
    rejectPendingInterruptPrompts(active, createAbortError())
    if (!active.session) rejectActiveReady(active, createAbortError())
    active.session?.abortCompaction()
    await active.session?.abort().catch(() => {})
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('当前会话没有正在运行的 Agent')
    const session = await waitForActiveSession(active)
    if (active.abortRequested) throw createAbortError()
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    const preparedPrompt = active.resourceLoader
      ? await preparePromptWithPromaSkills(
        active.resourceLoader,
        message.message.content,
        options?.skillMentions,
        active.skillWorkspaceSlug,
      )
      : { content: message.message.content, activations: [] }
    const content = preparedPrompt.content
    const skillActivationId = registerPromptSkillActivations(
      active,
      content,
      message.uuid,
      preparedPrompt.activations,
    )
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      active.pendingSkillActivations.discard(skillActivationId)
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    if (options?.interrupt) {
      const accepted = new Promise<void>((resolve, reject) => {
        active.pendingInterruptPrompts.push({
          content,
          skillActivationId,
          resolveAccepted: resolve,
          rejectAccepted: reject,
        })
      })
      accepted.catch(() => {})
      if (session.isStreaming) {
        // Pi 没有单独的 interrupt()；公开取消 API 是 abort()。
        // 这里把 abort 产生的内部 aborted 终态压住，再由 query 的 prompt chain 发送新消息。
        active.interrupting = true
        active.interruptAbortPromise ??= session.abort()
          .finally(() => {
            active.interruptAbortPromise = undefined
          })
        await active.interruptAbortPromise
      }
      await accepted
      options.onAccepted?.()
      return
    }
    try {
      if (message.priority === 'now') {
        await session.steer(content)
      } else {
        await session.followUp(content)
      }
    } catch (error) {
      active.pendingSkillActivations.discard(skillActivationId)
      throw error
    }
    options?.onAccepted?.()
  }

  async cancelQueuedMessage(_sessionId: string, _messageUuid: string): Promise<void> {
    // Pi 的公开 SDK 当前只暴露 clearQueue，不支持按消息 UUID 删除。
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // Proma 权限由工具包装层实时读取 sessionPermissionModes，自身无需同步给 Pi。
  }

  dispose(): void {
    for (const active of this.activeSessions.values()) {
      if (!active.disposed) {
        active.disposed = true
        rejectPendingInterruptPrompts(active, createAbortError())
        active.pendingSkillActivations.clear()
        active.session?.dispose()
      }
      rejectActiveReady(active, createAbortError())
    }
    this.activeSessions.clear()
  }
}
