/**
 * Pi Runtime 用户 MCP 工具桥接层
 *
 * Claude runtime 继续使用 Claude Agent SDK 原生 mcpServers；Pi SDK 当前没有等价
 * mcpServers 参数，因此 Proma 在主进程连接用户配置的 MCP server，并把 MCP tools
 * 映射成 Pi customTools。
 *
 * 连接管理对齐官方 0.22.0 `src/main/lib/adapters/pi-mcp-tools.ts`：
 * - 每个 (server, configHash) 一条共享连接，按租约计数，最后一个租约释放后关闭；
 * - entry 级 AbortController + lifecycleGeneration，dispose 时取消在途握手；
 * - Streamable HTTP session 失效（404 / 400 session 错误）时自动重新握手；
 * - remote transport error 时淘汰连接，等待下次调用重建。
 *
 * 本地保留：per-server `proxyUrl`（createManagedProxyFetch）与全局代理 fetch。
 * 默认 manager 已接入系统网络运行时：先 `ensureReady()`，再按 networkEpoch
 * 淘汰远程连接；配置了 per-server 代理时仍优先使用该代理。
 */

import { createHash } from 'node:crypto'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'
import { Type } from 'typebox'
import { createManagedProxyFetch, type ManagedProxyFetch } from '../proxy-fetch'
import { sanitizeToolResultImageContent } from '../image-content-validation'
import {
  connectMcpClient,
  createRemoteMcpTransport,
  normalizeMcpTransportError,
  withMcpSignal,
} from '../network/mcp-transport'
import { NetworkRequestError } from '../network/network-errors'

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000
const OPTIONAL_MCP_BOOTSTRAP_TIMEOUT_MS = 500
/**
 * required MCP 连接失败后的冷却窗口。冷却期内按可选服务器处理（本回合最多等
 * bootstrap 窗口，后台继续重连），避免失效服务器让每轮 Agent 请求都阻塞完整的
 * 握手超时（默认 30s connect + 60s listTools）。
 */
const REQUIRED_MCP_FAILURE_COOLDOWN_MS = 2 * 60_000
/** 失败冷却表的防御性上限；超出时淘汰最旧记录，避免配置频繁变更导致无限增长。 */
const REQUIRED_MCP_FAILURE_CACHE_LIMIT = 64
const HTTP_SESSION_REJECTION_PATTERN = /missing session id|no valid session id provided|mcp-session-id header is required/i

/** required MCP 最近一次工具发现失败的时间（key: serverName + 配置摘要）。 */
const requiredMcpFailureTimestamps = new Map<string, number>()

function markRequiredMcpFailure(key: string): void {
  if (requiredMcpFailureTimestamps.size >= REQUIRED_MCP_FAILURE_CACHE_LIMIT) {
    const oldestKey = requiredMcpFailureTimestamps.keys().next().value
    if (oldestKey !== undefined) requiredMcpFailureTimestamps.delete(oldestKey)
  }
  requiredMcpFailureTimestamps.set(key, Date.now())
}

interface PiMcpServerConfig {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  startup_timeout_sec?: unknown
  timeout?: unknown
  proxyUrl?: unknown
  required?: unknown
}

type PiMcpServers = Record<string, Record<string, unknown>>

type McpToolInfo = Awaited<ReturnType<Client['listTools']>>['tools'][number]

type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>

interface McpConnection {
  client: Client
  transport: Transport
  close: () => Promise<void>
  proxyFetch?: ManagedProxyFetch
  tools?: McpToolInfo[]
  toolsPromise?: Promise<McpToolInfo[]>
}

interface McpConnectionState {
  /** 连接被淘汰/关闭后为 true；fetcher 会据此拒绝新的网络请求。 */
  retired: boolean
  controller: AbortController
}

interface McpConnectionEntry {
  remote: boolean
  state: McpConnectionState
  promise: Promise<McpConnection>
  activeLeases: number
  stale: boolean
  closed: boolean
}

interface McpConnectionLease {
  key: string
  entry: McpConnectionEntry
  connection: McpConnection
}

interface McpToolBinding {
  serverName: string
  originalToolName: string
  tool: McpToolInfo
  manager: PiMcpClientManager
  managerConfig: PiMcpServerConfig
}

/**
 * 系统网络运行时最小接口。
 *
 * 官方 `systemNetwork` 提供 ensureReady / snapshot().networkEpoch / subscribe。
 * 本地子集只消费 epoch 订阅；当它变化时淘汰所有远程连接，等待下次调用重建。
 * 未来接入系统网络时，provider 需先完成 ensureReady 再返回 source。
 */
export interface PiMcpNetworkRuntime {
  /** 等待系统网络策略就绪；旧 runtime 可省略。 */
  ensureReady?(): Promise<void>
  snapshot(): { networkEpoch: number }
  subscribe(listener: () => void): () => void
}

export interface PiMcpClientManagerDependencies {
  /** 系统网络 fetcher；未提供时使用 per-server 代理 fetch 或全局 fetch。 */
  fetcher?: FetchLike
  /** 系统网络运行时 provider；未提供时使用空实现（本地子集）。 */
  network?: () => Promise<PiMcpNetworkRuntime>
}

const idleMcpNetworkRuntime: PiMcpNetworkRuntime = {
  snapshot: () => ({ networkEpoch: 0 }),
  subscribe: () => () => undefined,
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function configHash(config: unknown): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

function normalizeToolSegment(segment: string): string {
  const normalized = segment.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) return 'unnamed'
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`
}

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeToolSegment(serverName)}__${normalizeToolSegment(toolName)}`
}

function getHeaders(config: PiMcpServerConfig): Record<string, string> | undefined {
  if (!config.headers || typeof config.headers !== 'object') return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers as Record<string, unknown>)) {
    if (typeof value === 'string') headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function getTimeoutMs(config: PiMcpServerConfig): number {
  const timeoutSec = typeof config.startup_timeout_sec === 'number'
    ? config.startup_timeout_sec
    : typeof config.timeout === 'number'
      ? config.timeout
      : undefined
  if (!timeoutSec || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS
  return timeoutSec * 1000
}

function getProxyFetch(config: PiMcpServerConfig): ManagedProxyFetch | undefined {
  return typeof config.proxyUrl === 'string' && config.proxyUrl.trim()
    ? createManagedProxyFetch(config.proxyUrl)
    : undefined
}

function isRemoteConfig(config: PiMcpServerConfig): boolean {
  return config.type === 'http' || config.type === 'sse'
}

/**
 * 构造 transport。
 *
 * stdio 分支与移植前完全一致；远程分支统一走 `network/mcp-transport`，
 * 由它负责 URL 校验、headers 注入与 fetch 选择。
 */
function createTransport(name: string, config: PiMcpServerConfig, fetcher: FetchLike): Transport | undefined {
  const type = config.type
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) {
      console.warn(`[Pi MCP] MCP 服务器 ${name} 缺少 command，已跳过`)
      return undefined
    }
    const env = typeof config.env === 'object' && config.env
      ? Object.fromEntries(Object.entries(config.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      : undefined
    return new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      env,
      stderr: 'inherit',
    })
  }

  if (type === 'http' || type === 'sse') {
    if (typeof config.url !== 'string' || !config.url.trim()) {
      throw new Error('MCP服务器缺少 url')
    }
    return createRemoteMcpTransport(type, config.url, getHeaders(config), fetcher)
  }

  console.warn(`[Pi MCP] MCP 服务器 ${name} 使用暂不支持的类型 ${String(type)}，已跳过`)
  return undefined
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return !!schema && typeof schema === 'object' && !Array.isArray(schema)
}

function toTypeBoxSchema(schema: unknown): TSchema {
  if (!isObjectSchema(schema)) return Type.Object({})
  if (schema.type !== 'object') return Type.Object({})
  return Type.Unsafe(schema)
}

function stringifyForTool(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

function convertMcpResult(result: McpCallToolResult): AgentToolResult<unknown> {
  const content: Array<TextContent | ImageContent> = []

  if ('content' in result && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      } else {
        content.push({ type: 'text', text: stringifyForTool(block) })
      }
    }
  } else if ('toolResult' in result) {
    content.push({ type: 'text', text: stringifyForTool(result.toolResult) })
  }

  if ('structuredContent' in result && result.structuredContent !== undefined) {
    content.push({ type: 'text', text: `structuredContent:\n${stringifyForTool(result.structuredContent)}` })
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: stringifyForTool(result) })
  }

  if ('isError' in result && result.isError) {
    content.unshift({ type: 'text', text: 'MCP tool returned isError=true.' })
  }

  return {
    content: sanitizeToolResultImageContent(content),
    details: result,
  } as AgentToolResult<unknown>
}

/**
 * Optional MCP 服务首次连接在后台继续；首轮消息最多为它等待短暂的 bootstrap 窗口。
 * 连接完成后，manager 会缓存 tools，后续回合直接复用，不会重复冷启动 stdio 进程。
 */
async function listOptionalMcpTools(
  manager: PiMcpClientManager,
  serverName: string,
  config: PiMcpServerConfig,
): Promise<McpToolInfo[] | undefined> {
  const toolsPromise = manager.listTools(serverName, config)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      toolsPromise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), OPTIONAL_MCP_BOOTSTRAP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Required MCP 需要等待真实握手结果，保证刚连接/刚变更配置的服务器在本回合即可用。
 * 但一旦最近一次工具发现失败过，冷却期内回落到 optional 竞态（后台继续重连），
 * 避免断网、失效凭据或异常服务器反复阻塞后续每一轮消息。冷却期内的后台重连一旦
 * 成功，立即退出冷却并恢复 required 语义。
 */
async function listRequiredMcpTools(
  manager: PiMcpClientManager,
  serverName: string,
  config: PiMcpServerConfig,
): Promise<McpToolInfo[] | undefined> {
  const failureKey = `${serverName}:${configHash(config)}`
  const failedAt = requiredMcpFailureTimestamps.get(failureKey)
  if (failedAt !== undefined && Date.now() - failedAt < REQUIRED_MCP_FAILURE_COOLDOWN_MS) {
    const tools = await listOptionalMcpTools(manager, serverName, config)
    if (tools) requiredMcpFailureTimestamps.delete(failureKey)
    return tools
  }
  try {
    const tools = await manager.listTools(serverName, config)
    requiredMcpFailureTimestamps.delete(failureKey)
    return tools
  } catch (error) {
    markRequiredMcpFailure(failureKey)
    console.warn(
      `[Pi MCP] required MCP 服务器 ${serverName} 连接失败，${REQUIRED_MCP_FAILURE_COOLDOWN_MS / 1000}s 冷却期内将按可选服务器处理`,
      error,
    )
    throw error
  }
}

export class PiMcpClientManager {
  private readonly dependencies: PiMcpClientManagerDependencies
  private readonly fetcher: FetchLike
  private readonly connections = new Map<string, McpConnectionEntry>()
  private readonly allEntries = new Set<McpConnectionEntry>()
  private lifecycleGeneration = 0
  private networkReady?: Promise<void>
  private unsubscribeNetwork?: () => void

  constructor(dependencies: PiMcpClientManagerDependencies = {}) {
    this.dependencies = dependencies
    this.fetcher = dependencies.fetcher ?? ((input, init) => fetch(input, init))
  }

  /**
   * 等待系统网络就绪，并订阅 networkEpoch 变化。
   * 本地子集：默认 runtime 恒为 epoch 0，不会淘汰连接；接入系统网络后由
   * provider 返回真实 runtime 即可获得官方的“网络切换后重连”行为。
   */
  private ensureNetwork(): Promise<void> {
    if (!this.networkReady) {
      const generation = this.lifecycleGeneration
      this.networkReady = (async () => {
        const source = this.dependencies.network
          ? await this.dependencies.network()
          : idleMcpNetworkRuntime
        await source.ensureReady?.()
        if (generation !== this.lifecycleGeneration) throw new Error('MCP生命周期已结束')

        let epoch = source.snapshot().networkEpoch
        this.unsubscribeNetwork = source.subscribe(() => {
          const next = source.snapshot().networkEpoch
          if (next === epoch) return
          epoch = next
          for (const [key, entry] of this.connections) {
            if (entry.remote) this.retireEntry(key, entry)
          }
          requiredMcpFailureTimestamps.clear()
        })
      })().catch((error: unknown) => {
        if (generation === this.lifecycleGeneration) this.networkReady = undefined
        throw error
      })
    }
    return this.networkReady
  }

  private retireEntry(key: string, entry: McpConnectionEntry): void {
    entry.stale = true
    entry.state.retired = true
    if (this.connections.get(key) === entry) this.connections.delete(key)
    if (entry.activeLeases === 0) void this.closeEntry(entry)
  }

  private async closeEntry(entry: McpConnectionEntry): Promise<void> {
    if (entry.closed) return
    entry.closed = true
    entry.state.controller.abort()
    this.allEntries.delete(entry)
    try {
      const connection = await entry.promise
      await connection.close()
    } catch {
      // 连接本身失败或已被服务端关闭，忽略清理错误。
    }
  }

  /**
   * 关闭所有活跃的 MCP 连接，释放 stdio 子进程和网络资源。
   * 应在 app quit 或 agent session 结束时调用。
   */
  async dispose(): Promise<void> {
    this.lifecycleGeneration += 1
    this.unsubscribeNetwork?.()
    this.unsubscribeNetwork = undefined
    this.networkReady = undefined

    const entries = [...this.allEntries]
    this.connections.clear()
    requiredMcpFailureTimestamps.clear()
    for (const entry of entries) {
      entry.stale = true
      entry.state.retired = true
    }
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry)))
  }

  async listTools(serverName: string, config: PiMcpServerConfig): Promise<McpToolInfo[]> {
    return this.executeWithSessionRecovery(serverName, config, undefined, true, async (connection) => {
      if (connection.tools) return connection.tools
      if (!connection.toolsPromise) {
        connection.toolsPromise = connection.client.listTools(undefined, { timeout: DEFAULT_MCP_REQUEST_TIMEOUT_MS })
          .then((result) => {
            connection.tools = result.tools
            return result.tools
          })
          .catch((error) => {
            connection.toolsPromise = undefined
            throw error
          })
      }
      return connection.toolsPromise
    })
  }

  async callTool(serverName: string, config: PiMcpServerConfig, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
    return this.executeWithSessionRecovery(serverName, config, signal, false, (connection) =>
      connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: DEFAULT_MCP_REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true },
      ))
  }

  private async executeWithSessionRecovery<T>(
    serverName: string,
    config: PiMcpServerConfig,
    signal: AbortSignal | undefined,
    allowReplay: boolean,
    operation: (connection: McpConnection) => Promise<T>,
  ): Promise<T> {
    const lifecycleGeneration = this.lifecycleGeneration
    signal?.throwIfAborted()
    const lease = await this.acquireConnection(serverName, config, signal)
    let leaseReleased = false
    try {
      try {
        signal?.throwIfAborted()
        return await operation(lease.connection)
      } catch (error) {
        // 远程连接在任意调用错误后都视为不可复用；stdio 保持原行为。
        if (lease.entry.remote) this.markConnectionStale(lease)
        if (!this.isRejectedHttpSession(error, lease.connection)) {
          throw error
        }

        this.markConnectionStale(lease)
        await this.releaseConnection(lease)
        leaseReleased = true
        if (!allowReplay || signal?.aborted || this.lifecycleGeneration !== lifecycleGeneration) throw error

        console.info(`[Pi MCP] MCP 服务器 ${serverName} Session 已失效，正在重新握手`)

        const replacement = await this.acquireConnection(serverName, config, signal)
        try {
          try {
            return await operation(replacement.connection)
          } catch (retryError) {
            if (this.isRejectedHttpSession(retryError, replacement.connection)) {
              this.markConnectionStale(replacement)
            }
            throw retryError
          }
        } finally {
          await this.releaseConnection(replacement)
        }
      }
    } finally {
      if (!leaseReleased) {
        await this.releaseConnection(lease)
      }
    }
  }

  private isRejectedHttpSession(error: unknown, connection: McpConnection): boolean {
    if (!(connection.transport instanceof StreamableHTTPClientTransport)) return false
    if (connection.transport.sessionId === undefined) return false
    if (!(error instanceof StreamableHTTPError)) return false
    if (error.code === 404) return true
    return error.code === 400 && HTTP_SESSION_REJECTION_PATTERN.test(error.message)
  }

  private async acquireConnection(
    serverName: string,
    config: PiMcpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<McpConnectionLease> {
    const remote = isRemoteConfig(config)
    if (remote) await withMcpSignal(this.ensureNetwork(), signal)
    signal?.throwIfAborted()

    const key = `${serverName}:${configHash(config)}`
    let entry = this.connections.get(key)

    if (!entry) {
      let createdEntry!: McpConnectionEntry
      const state: McpConnectionState = { retired: false, controller: new AbortController() }
      const promise = this.createConnection(serverName, config, state, () => {
        createdEntry.stale = true
        state.retired = true
        this.allEntries.delete(createdEntry)
        if (this.connections.get(key) === createdEntry) {
          this.connections.delete(key)
        }
        // transport 已由服务端/自身关闭，但仍需释放 per-server 代理 dispatcher。
        void this.closeEntry(createdEntry)
      }, () => {
        if (remote) this.retireEntry(key, createdEntry)
      }).catch((error: unknown) => {
        createdEntry.stale = true
        this.allEntries.delete(createdEntry)
        if (this.connections.get(key) === createdEntry) {
          this.connections.delete(key)
        }
        throw error
      })
      createdEntry = {
        remote,
        state,
        promise,
        activeLeases: 0,
        stale: false,
        closed: false,
      }
      entry = createdEntry
      this.connections.set(key, entry)
      this.allEntries.add(entry)
    }

    entry.activeLeases += 1
    try {
      return {
        key,
        entry,
        connection: await withMcpSignal(entry.promise, signal),
      }
    } catch (error) {
      entry.activeLeases -= 1
      if (entry.activeLeases === 0 && signal?.aborted) this.retireEntry(key, entry)
      throw error
    }
  }

  private markConnectionStale(lease: McpConnectionLease): void {
    this.retireEntry(lease.key, lease.entry)
  }

  private async releaseConnection(lease: McpConnectionLease): Promise<void> {
    lease.entry.activeLeases -= 1
    if (lease.entry.stale && lease.entry.activeLeases === 0) await this.closeEntry(lease.entry)
  }

  private async createConnection(
    serverName: string,
    config: PiMcpServerConfig,
    state: McpConnectionState,
    onClose: () => void,
    onStale: () => void,
  ): Promise<McpConnection> {
    const remote = isRemoteConfig(config)
    const proxyFetch = remote ? getProxyFetch(config) : undefined
    const baseFetcher: FetchLike = proxyFetch?.fetch ?? this.fetcher

    // 所有远程请求都带上 entry 级 signal：dispose / 淘汰时立即中断在途请求。
    const entryFetcher: FetchLike = async (input, init) => {
      if (state.retired) throw new NetworkRequestError('connect', 'mcp')
      const signals = init?.signal
        ? [state.controller.signal, init.signal]
        : [state.controller.signal]
      return baseFetcher(input, { ...init, signal: AbortSignal.any(signals) })
    }

    let transport: Transport | undefined
    try {
      transport = createTransport(serverName, config, entryFetcher)
    } catch (error) {
      await proxyFetch?.close()
      throw normalizeMcpTransportError(error, 'mcp')
    }
    if (!transport) {
      await proxyFetch?.close()
      throw new Error(`无法创建 MCP transport: ${serverName}`)
    }

    const client = new Client({ name: 'proma-pi-agent-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
    try {
      await connectMcpClient(client, transport, getTimeoutMs(config), state.controller.signal)
    } catch (error) {
      // connectMcpClient 已关闭 transport；这里只需释放代理 dispatcher。
      await proxyFetch?.close()
      throw normalizeMcpTransportError(error, 'mcp')
    }

    const activeTransport = transport
    let closing = false

    const previousOnError = activeTransport.onerror
    activeTransport.onerror = (error) => {
      previousOnError?.(error)
      if (!closing) {
        onStale()
        // 只记录 name，避免把可能含认证信息的 transport 错误写进日志。
        console.warn(`[Pi MCP] MCP 服务器 ${serverName} transport error:`, error.name)
      }
    }
    const previousOnClose = activeTransport.onclose
    activeTransport.onclose = () => {
      closing = true
      previousOnClose?.()
      onClose()
    }

    return {
      client,
      transport: activeTransport,
      proxyFetch,
      close: async () => {
        closing = true
        try {
          await activeTransport.close()
        } finally {
          await proxyFetch?.close()
        }
      },
    }
  }
}

const manager = new PiMcpClientManager({
  network: async () => {
    const { systemNetwork } = await import('../network/system-network-runtime')
    return {
      ensureReady: () => systemNetwork.ensureReady(),
      snapshot: () => systemNetwork.snapshot(),
      subscribe: (listener) => systemNetwork.subscribe(() => listener()),
    }
  },
  fetcher: async (input, init) => {
    const { getSystemFetch } = await import('../network/system-network-runtime')
    return getSystemFetch('mcp')(input, init)
  },
})

function createPiMcpToolDefinition(binding: McpToolBinding): ToolDefinition {
  const toolName = mcpToolName(binding.serverName, binding.originalToolName)
  const description = binding.tool.description || `Call MCP tool ${binding.originalToolName} from server ${binding.serverName}`

  return {
    name: toolName,
    label: toolName,
    description,
    promptSnippet: `${toolName}: ${description}`,
    parameters: toTypeBoxSchema(binding.tool.inputSchema),
    async execute(_toolCallId, params, signal) {
      const args = isObjectSchema(params) ? params as Record<string, unknown> : {}
      const result = await binding.manager.callTool(binding.serverName, binding.managerConfig, binding.originalToolName, args, signal)
      return convertMcpResult(result)
    },
  } as ToolDefinition
}

/**
 * 将 Proma 已构建的 MCP server 配置转换为 Pi customTools。
 *
 * 注意：本函数仅供 Pi runtime 使用；Claude runtime 仍直接把 mcpServers 交给
 * Claude Agent SDK，不经过这里。
 */
export async function buildPiMcpTools(mcpServers: PiMcpServers, proxyUrl?: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  const proxiedServers = proxyUrl
    ? Object.fromEntries(Object.entries(mcpServers).map(([name, config]) => {
      const type = (config as PiMcpServerConfig).type
      return [name, {
        ...config,
        ...(type === 'http' || type === 'sse' ? { proxyUrl } : {}),
      }]
    })) as PiMcpServers
    : mcpServers
  const seenToolNames = new Set<string>()

  // 并行连接所有 MCP 服务器，避免串行等待导致启动慢
  const entries = Object.entries(proxiedServers).filter(([, rawConfig]) => {
    const type = (rawConfig as PiMcpServerConfig).type
    return type === 'stdio' || type === 'http' || type === 'sse'
  })

  const results = await Promise.allSettled(
    entries.map(async ([serverName, rawConfig]) => {
      const config = rawConfig as PiMcpServerConfig
      const mcpTools = config.required === false
        ? await listOptionalMcpTools(manager, serverName, config)
        : await listRequiredMcpTools(manager, serverName, config)
      if (!mcpTools) {
        console.info(`[Pi MCP] 可选 MCP 服务器 ${serverName} 尚在后台启动，本回合跳过`)
        return { serverName, config, mcpTools: [] }
      }
      return { serverName, config, mcpTools }
    }),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[Pi MCP] 连接或列出 MCP 服务器工具失败，已跳过:', result.reason)
      continue
    }
    const { serverName, config, mcpTools } = result.value
    for (const tool of mcpTools) {
      const piToolName = mcpToolName(serverName, tool.name)
      if (seenToolNames.has(piToolName)) {
        console.warn(`[Pi MCP] 工具名冲突 ${piToolName}，已跳过 ${serverName}/${tool.name}`)
        continue
      }
      seenToolNames.add(piToolName)
      tools.push(createPiMcpToolDefinition({
        serverName,
        originalToolName: tool.name,
        tool,
        manager,
        managerConfig: config,
      }))
    }
  }

  if (tools.length > 0) {
    console.log(`[Pi MCP] 已桥接 ${tools.length} 个用户 MCP 工具到 Pi customTools`)
  }

  return tools
}

/**
 * 关闭所有 MCP 连接。应在 app quit 时调用以清理 stdio 子进程。
 */
export async function disposePiMcpConnections(): Promise<void> {
  await manager.dispose()
}
