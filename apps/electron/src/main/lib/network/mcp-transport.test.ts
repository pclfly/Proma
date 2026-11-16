import { describe, expect, mock, test } from 'bun:test'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import { NetworkRequestError } from './network-errors'
import {
  MCP_HANDSHAKE_TIMEOUT_MESSAGE,
  MCP_REMOTE_URL_INVALID_MESSAGE,
  McpHandshakeTimeoutError,
  McpTransportConfigError,
  classifyMcpTransportFailure,
  connectMcpClient,
  createRemoteMcpTransport,
  isValidMcpRemoteUrl,
  normalizeMcpTransportError,
  parseMcpRemoteUrl,
  withMcpSignal,
  type McpConnectableClient,
} from './mcp-transport'

function fakeTransport(): Transport & { closeCalls: number } {
  const transport = {
    closeCalls: 0,
    async start(): Promise<void> {
      // 测试不真正建立连接
    },
    async send(): Promise<void> {
      // 测试不发送消息
    },
    async close(): Promise<void> {
      transport.closeCalls += 1
    },
  }
  return transport as unknown as Transport & { closeCalls: number }
}

function fakeClient(connect: McpConnectableClient['connect']): McpConnectableClient {
  return { connect }
}

describe('MCP remote URL validation', () => {
  test('Given HTTP(S) targets When parsed Then keeps protocol, host and path', () => {
    expect(parseMcpRemoteUrl('https://example.com/mcp').href).toBe('https://example.com/mcp')
    expect(parseMcpRemoteUrl('http://127.0.0.1:14242/mcp/?token=1').href)
      .toBe('http://127.0.0.1:14242/mcp/?token=1')
  })

  test('Given a non-HTTP scheme When parsed as http transport Then rejects with the official message', () => {
    for (const url of [
      'ftp://example.com/mcp',
      'file:///tmp/mcp.sock',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'ws://example.com/mcp',
    ]) {
      expect(() => parseMcpRemoteUrl(url, 'http')).toThrow(McpTransportConfigError)
      try {
        parseMcpRemoteUrl(url, 'http')
      } catch (error) {
        expect(error).toBeInstanceOf(McpTransportConfigError)
        expect((error as McpTransportConfigError).code).toBe('mcp_invalid_url')
        expect((error as Error).message).toBe(MCP_REMOTE_URL_INVALID_MESSAGE)
      }
    }
  })

  test('Given embedded credentials When parsed Then rejects to keep secrets out of logs', () => {
    for (const url of [
      'https://user:pass@example.com/mcp',
      'https://user@example.com/mcp',
      'https://:pass@example.com/mcp',
    ]) {
      expect(() => parseMcpRemoteUrl(url)).toThrow(McpTransportConfigError)
    }
  })

  test('Given malformed or empty input When validated Then returns false', () => {
    for (const value of ['', '   ', 'not a url', null, undefined, 42, {}]) {
      expect(isValidMcpRemoteUrl(value)).toBe(false)
    }
    expect(isValidMcpRemoteUrl('https://example.com/mcp')).toBe(true)
  })

  test('Given WebSocket transport When URL uses ws/wss Then accepts, but http scheme is rejected', () => {
    expect(parseMcpRemoteUrl('wss://example.com/mcp', 'websocket').protocol).toBe('wss:')
    expect(parseMcpRemoteUrl('ws://127.0.0.1:14242/mcp', 'websocket').protocol).toBe('ws:')
    expect(() => parseMcpRemoteUrl('https://example.com/mcp', 'websocket')).toThrow(McpTransportConfigError)
  })
})

describe('MCP transport factory', () => {
  test('Given http type When created Then returns StreamableHTTPClientTransport with headers', () => {
    const transport = createRemoteMcpTransport('http', 'https://example.com/mcp', { Authorization: 'Bearer token' })
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    const requestInit = (transport as unknown as { _requestInit?: { headers?: Record<string, string> } })._requestInit
    expect(requestInit?.headers).toEqual({ Authorization: 'Bearer token' })
  })

  test('Given sse type When created Then returns SSEClientTransport and merges headers into the event stream fetch', async () => {
    const fetcher = mock(async () => new Response(null, { status: 204 }))
    const transport = createRemoteMcpTransport(
      'sse',
      'https://example.com/sse',
      { Authorization: 'Bearer token' },
      fetcher as unknown as FetchLike,
    )
    expect(transport).toBeInstanceOf(SSEClientTransport)

    const eventSourceInit = (transport as unknown as {
      _eventSourceInit?: { fetch?: (input: string | URL, init: RequestInit) => Promise<unknown> }
    })._eventSourceInit
    await eventSourceInit?.fetch?.('https://example.com/sse', { headers: { 'X-Trace': '1' } })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = (fetcher.mock.calls[0] as unknown[])[1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token')
    expect(headers.get('X-Trace')).toBe('1')
  })

  test('Given websocket type When created Then returns WebSocketClientTransport', () => {
    expect(createRemoteMcpTransport('websocket', 'wss://example.com/mcp')).toBeInstanceOf(WebSocketClientTransport)
  })

  test('Given websocket headers When created Then rejects instead of silently dropping auth', () => {
    try {
      createRemoteMcpTransport('websocket', 'wss://example.com/mcp', { Authorization: 'Bearer token' })
      throw new Error('expected createRemoteMcpTransport to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(McpTransportConfigError)
      expect((error as McpTransportConfigError).code).toBe('mcp_unsupported_headers')
    }
  })

  test('Given an invalid target When created Then throws the config error', () => {
    expect(() => createRemoteMcpTransport('http', 'ftp://example.com/mcp')).toThrow(MCP_REMOTE_URL_INVALID_MESSAGE)
  })
})

describe('MCP transport error classification', () => {
  test('Given a handshake timeout When classified Then reports timeout with the specific message', () => {
    expect(classifyMcpTransportFailure(new McpHandshakeTimeoutError())).toEqual({
      kind: 'timeout',
      message: MCP_HANDSHAKE_TIMEOUT_MESSAGE,
    })
  })

  test('Given an invalid URL config error When classified Then keeps the safe code', () => {
    expect(classifyMcpTransportFailure(
      new McpTransportConfigError('mcp_invalid_url', MCP_REMOTE_URL_INVALID_MESSAGE),
    )).toEqual({
      kind: 'unknown',
      message: MCP_REMOTE_URL_INVALID_MESSAGE,
      safeCode: 'mcp_invalid_url',
    })
  })

  test('Given abort/DNS/TLS errors When classified Then maps to the shared network kinds', () => {
    expect(classifyMcpTransportFailure(new DOMException('cancelled', 'AbortError'))).toMatchObject({
      kind: 'cancelled',
      message: '请求已取消。',
    })
    expect(classifyMcpTransportFailure(Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' })))
      .toMatchObject({ kind: 'dns', safeCode: 'ENOTFOUND' })
    expect(classifyMcpTransportFailure(Object.assign(new Error('certificate invalid'), { code: 'ERR_CERT_AUTHORITY_INVALID' })))
      .toMatchObject({ kind: 'tls', safeCode: 'ERR_CERT_AUTHORITY_INVALID' })
    expect(classifyMcpTransportFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
      .toMatchObject({ kind: 'connect', safeCode: 'ECONNREFUSED' })
  })

  test('Given an unknown error When classified Then never leaks the original message', () => {
    expect(classifyMcpTransportFailure(new Error('boom at https://secret.example/mcp'))).toEqual({
      kind: 'unknown',
      message: '网络请求未完成，请检查系统网络后重试。',
    })
  })
})

describe('MCP transport error normalization', () => {
  test('Given low-level network errors When normalized Then returns NetworkRequestError with cause', () => {
    const original = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const normalized = normalizeMcpTransportError(original, 'mcp')
    expect(normalized).toBeInstanceOf(NetworkRequestError)
    expect(normalized).toMatchObject({ kind: 'connect', scope: 'mcp', causeCode: 'ECONNREFUSED' })
    expect((normalized as Error).cause).toBe(original)
    expect((normalized as Error).message).not.toContain('https://secret.example')
  })

  test('Given config/timeout/abort/protocol errors When normalized Then returns the original instance', () => {
    const configError = new McpTransportConfigError('mcp_invalid_url', MCP_REMOTE_URL_INVALID_MESSAGE)
    const timeoutError = new McpHandshakeTimeoutError()
    const abortError = new DOMException('cancelled', 'AbortError')
    const httpError = new StreamableHTTPError(404, 'missing session id')
    const networkError = new NetworkRequestError('dns', 'mcp')

    expect(normalizeMcpTransportError(configError)).toBe(configError)
    expect(normalizeMcpTransportError(timeoutError)).toBe(timeoutError)
    expect(normalizeMcpTransportError(abortError)).toBe(abortError)
    expect(normalizeMcpTransportError(httpError)).toBe(httpError)
    expect(normalizeMcpTransportError(networkError)).toBe(networkError)
  })

  test('Given an unknown error When normalized Then does not wrap it', () => {
    const error = new Error('tool exploded')
    expect(normalizeMcpTransportError(error)).toBe(error)
  })
})

describe('MCP cancellation', () => {
  test('Given no signal When operation resolves Then returns the value', async () => {
    await expect(withMcpSignal(Promise.resolve('ok'))).resolves.toBe('ok')
  })

  test('Given an already aborted signal When waiting Then rejects with AbortError without invoking the operation', async () => {
    const controller = new AbortController()
    controller.abort()
    const operation = mock(() => Promise.resolve('late'))

    await expect(withMcpSignal(operation(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given an abort during the operation When waiting Then rejects with AbortError', async () => {
    const controller = new AbortController()
    const pending = withMcpSignal(Bun.sleep(5_000).then(() => 'late'), controller.signal)
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given an operation rejection When waiting Then propagates the original error', async () => {
    const error = new Error('boom')
    await expect(withMcpSignal(Promise.reject(error))).rejects.toBe(error)
  })
})

describe('MCP client connect', () => {
  test('Given a successful connect When it resolves Then keeps the transport open', async () => {
    const transport = fakeTransport()
    const client = fakeClient(async () => undefined)

    await connectMcpClient(client, transport, 1_000)
    expect(transport.closeCalls).toBe(0)
  })

  test('Given connect rejects When it fails Then closes the transport and rethrows', async () => {
    const transport = fakeTransport()
    const error = new Error('handshake rejected')
    const client = fakeClient(async () => {
      throw error
    })

    await expect(connectMcpClient(client, transport, 1_000)).rejects.toBe(error)
    expect(transport.closeCalls).toBe(1)
  })

  test('Given connect hangs When the timeout fires Then rejects with a handshake timeout and closes the transport', async () => {
    const transport = fakeTransport()
    const client = fakeClient(() => new Promise<void>(() => undefined))

    await expect(connectMcpClient(client, transport, 20)).rejects.toBeInstanceOf(McpHandshakeTimeoutError)
    expect(transport.closeCalls).toBe(1)
    expect(MCP_HANDSHAKE_TIMEOUT_MESSAGE).toBe('MCP握手超时')
  })

  test('Given an aborted signal When connecting Then closes the transport and rejects with AbortError', async () => {
    const transport = fakeTransport()
    const connectCalls = mock(() => new Promise<void>(() => undefined))
    const controller = new AbortController()

    const pending = connectMcpClient(fakeClient(connectCalls), transport, 1_000, controller.signal)
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(connectCalls).toHaveBeenCalledTimes(1)
    expect(transport.closeCalls).toBe(1)
  })

  test('Given an already aborted signal When connecting Then never calls connect', async () => {
    const transport = fakeTransport()
    const connectCalls = mock(() => Promise.resolve())
    const controller = new AbortController()
    controller.abort()

    await expect(connectMcpClient(fakeClient(connectCalls), transport, 1_000, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(connectCalls).toHaveBeenCalledTimes(0)
  })
})
