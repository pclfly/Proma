/**
 * 远程 MCP 传输层 — 官方 0.22.0 的本地可用子集。
 *
 * 官方来源：`src/main/lib/network/mcp-transport.ts`，负责按 config.type 构造
 * Streamable HTTP / SSE transport，并在握手时统一处理超时、取消与关闭。
 *
 * 本地移植范围：
 * - HTTP(S) URL 校验：仅允许 http/https，禁止内嵌用户名/密码；
 * - Streamable HTTP / SSE transport 构造与请求头注入；
 * - 握手超时（Promise.race + timer）、外部 AbortSignal 取消、失败时关闭 transport；
 * - 底层网络错误向 `NetworkRequestError` 的归一化（保留协议错误与 AbortError 语义）。
 *
 * 未移植（deferred，依赖官方 system network runtime / cloud auth）：
 * - `createHostSystemFetch("mcp")` 的 `systemNetwork.ensureReady()` 就绪等待；
 * - `networkEpoch` 变化后自动重连远程 MCP。
 * 本地由 `pi-mcp-tools` 的 per-server 代理 fetch 与全局 fetch 承担，接入点已通过
 * `PiMcpClientManager` 的 `network` 依赖留出。
 *
 * WebSocket 分支是本地扩展：官方 0.22.0 bundle 中不存在 MCP WebSocket 传输，
 * 且 `packages/shared` 的 `McpTransportType` 仍只允许 http/sse。该分支只对直接
 * 调用 `createRemoteMcpTransport` 的代码开放；配置/UI 链路接入为 deferred。
 */

import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import {
  NetworkRequestError,
  classifyNetworkError,
  safeNetworkErrorCode,
  type NetworkFailureKind,
} from './network-errors'

/** 远程 MCP 传输类型。配置层当前只产出 http / sse。 */
export type RemoteMcpTransportType = 'http' | 'sse' | 'websocket'

/** 官方 0.22.0 对非法远程目标的统一文案。 */
export const MCP_REMOTE_URL_INVALID_MESSAGE = 'MCP网络地址无效'
/** 官方 0.22.0 的握手超时文案。 */
export const MCP_HANDSHAKE_TIMEOUT_MESSAGE = 'MCP握手超时'
export const MCP_REQUEST_CANCELLED_MESSAGE = 'MCP请求已取消'

export type McpTransportConfigErrorCode = 'mcp_invalid_url' | 'mcp_unsupported_headers'

/**
 * 配置层错误：地址非法或当前传输不支持该配置。
 * 与网络错误区分，避免验证器把配置问题描述成网络故障。
 */
export class McpTransportConfigError extends Error {
  readonly code: McpTransportConfigErrorCode

  constructor(code: McpTransportConfigErrorCode, message: string) {
    super(message)
    this.name = 'McpTransportConfigError'
    this.code = code
  }
}

/**
 * 握手超时错误。name 使用 `TimeoutError`，让 `classifyNetworkError` 统一归到
 * `timeout`，同时保留比通用网络文案更具体的 MCP 语义。
 */
export class McpHandshakeTimeoutError extends Error {
  constructor() {
    super(MCP_HANDSHAKE_TIMEOUT_MESSAGE)
    this.name = 'TimeoutError'
  }
}

const defaultMcpFetch: FetchLike = (input, init) => fetch(input, init)

/**
 * 校验并解析远程 MCP 地址。
 *
 * - http/sse：只接受 http/https；
 * - websocket：只接受 ws/wss；
 * - 一律拒绝 URL 内嵌凭据（`https://user:pass@host`），避免凭据进入日志或错误信息。
 */
export function parseMcpRemoteUrl(rawUrl: string, type: RemoteMcpTransportType = 'http'): URL {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    throw new McpTransportConfigError('mcp_invalid_url', MCP_REMOTE_URL_INVALID_MESSAGE)
  }

  const allowedProtocols = type === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:']
  if (!allowedProtocols.includes(target.protocol) || target.username || target.password) {
    throw new McpTransportConfigError('mcp_invalid_url', MCP_REMOTE_URL_INVALID_MESSAGE)
  }

  return target
}

/** 纯布尔版本，供配置策略与 UI 预校验使用。 */
export function isValidMcpRemoteUrl(rawUrl: unknown, type: RemoteMcpTransportType = 'http'): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false
  try {
    parseMcpRemoteUrl(rawUrl.trim(), type)
    return true
  } catch {
    return false
  }
}

/**
 * 构造远程 MCP transport。与官方一致：sse 的 eventSourceInit 也要合并 headers
 * 与自定义 fetch，否则 GET 事件流会绕过代理和认证头。
 */
export function createRemoteMcpTransport(
  type: RemoteMcpTransportType,
  url: string,
  headers?: Record<string, string>,
  fetcher?: FetchLike,
): Transport {
  const target = parseMcpRemoteUrl(url, type)
  const effectiveFetcher = fetcher ?? defaultMcpFetch
  const requestInit = headers && Object.keys(headers).length > 0 ? { headers } : undefined

  if (type === 'http') {
    return new StreamableHTTPClientTransport(target, { requestInit, fetch: effectiveFetcher })
  }

  if (type === 'sse') {
    type SseEventSourceFetch = NonNullable<NonNullable<SSEClientTransportOptions['eventSourceInit']>['fetch']>
    const eventSourceFetch = ((input: string | URL, init?: RequestInit) => {
      const merged = new Headers(init?.headers)
      for (const [key, value] of Object.entries(headers ?? {})) merged.set(key, value)
      return effectiveFetcher(input, { ...init, headers: merged })
    }) as unknown as SseEventSourceFetch

    return new SSEClientTransport(target, {
      requestInit,
      fetch: effectiveFetcher,
      eventSourceInit: { fetch: eventSourceFetch },
    })
  }

  // SDK 的 WebSocketClientTransport 不接受自定义请求头（浏览器 WS 协议也不支持）。
  // 与其静默丢弃认证头，不如显式拒绝，避免用户以为凭据已经生效。
  if (headers && Object.keys(headers).length > 0) {
    throw new McpTransportConfigError('mcp_unsupported_headers', 'WebSocket MCP 不支持自定义请求头')
  }
  return new WebSocketClientTransport(target)
}

/** `Client.connect` 所需的最小结构，便于测试注入假客户端。 */
export interface McpConnectableClient {
  connect(transport: Transport, options?: { timeout?: number }): Promise<void>
}

/**
 * 连接 MCP client，并让握手同时受 timeout 与外部 signal 约束。
 * 失败时先关闭 transport（官方语义：避免半开连接泄漏），再把原始错误抛给调用方。
 */
export async function connectMcpClient(
  client: McpConnectableClient,
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await withMcpSignal(
      Promise.race([
        client.connect(transport, { timeout: timeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new McpHandshakeTimeoutError()), timeoutMs)
        }),
      ]),
      signal,
    )
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 把外部取消信号并入任意 Promise。
 * 预取消时先给原操作挂上 catch，避免调用方已返回后产生 unhandled rejection。
 */
export async function withMcpSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    if (!signal) return await operation
    if (signal.aborted) {
      void operation.catch(() => undefined)
      signal.throwIfAborted()
    }
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        abort = () => reject(new DOMException(MCP_REQUEST_CANCELLED_MESSAGE, 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

export interface McpTransportFailure {
  kind: NetworkFailureKind
  message: string
  safeCode?: string
}

/**
 * 传输层错误分类（纯函数）。供日志、验证器与测试共用；
 * 只返回可安全展示的 message 与错误码，不携带 URL、header 或堆栈。
 */
export function classifyMcpTransportFailure(error: unknown): McpTransportFailure {
  const kind = classifyNetworkError(error)
  const safeCode = error instanceof McpTransportConfigError
    ? error.code
    : safeNetworkErrorCode(error)
  const message = error instanceof McpTransportConfigError || error instanceof McpHandshakeTimeoutError
    ? error.message
    : new NetworkRequestError(kind, 'mcp').message
  return {
    kind,
    message,
    ...(safeCode ? { safeCode } : {}),
  }
}

/**
 * 归一化传输错误。
 *
 * 只包装底层网络故障（DNS/TLS/连接/代理/超时/流中断）；以下情况原样返回：
 * - `NetworkRequestError`：已归一化；
 * - `McpTransportConfigError` / `McpHandshakeTimeoutError`：文案稳定且安全；
 * - `AbortError`：调用方依赖它判断取消；
 * - `StreamableHTTPError` 等协议错误：sessionId 失效恢复依赖 404/400 原始错误。
 */
export function normalizeMcpTransportError(error: unknown, scope = 'mcp'): unknown {
  if (error instanceof NetworkRequestError) return error
  if (error instanceof McpTransportConfigError || error instanceof McpHandshakeTimeoutError) return error
  if (error instanceof Error && error.name === 'AbortError') return error

  const kind = classifyNetworkError(error)
  if (kind === 'unknown' || kind === 'cancelled') return error

  const normalized = new NetworkRequestError(kind, scope, safeNetworkErrorCode(error))
  if (error instanceof Error) normalized.cause = error
  return normalized
}
