import { describe, expect, test } from 'bun:test'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { PiMcpClientManager } from './pi-mcp-tools'

interface FakeMcpServerOptions {
  /** 第一次 tools/list 返回 404，模拟 Streamable HTTP session 失效。 */
  failFirstListWith404?: boolean
  /** tools/call 延迟响应，用于验证取消后的连接淘汰。 */
  delayCallToolMs?: number
}

/**
 * 最小 Streamable HTTP MCP 服务器假实现：
 * - GET 返回 405（不提供独立 SSE 流）；
 * - POST 处理 initialize / notifications/initialized / tools/list / tools/call；
 * - 通过 mcp-session-id 响应头模拟真实 session。
 */
function createFakeMcpServer(options: FakeMcpServerOptions = {}) {
  const methods: string[] = []
  let initializeCount = 0
  let listCount = 0

  const fetchImpl: FetchLike = async (_input, init) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(null, { status: 405 })
    if (method === 'DELETE') return new Response(null, { status: 405 })

    const message = JSON.parse(String(init?.body)) as {
      id?: string | number
      method?: string
    }
    if (message.method) methods.push(message.method)

    const json = (payload: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      })

    switch (message.method) {
      case 'initialize':
        initializeCount += 1
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-mcp', version: '1.0.0' },
          },
        }, { 'mcp-session-id': `session-${initializeCount}` })

      case 'notifications/initialized':
        return new Response(null, { status: 202 })

      case 'tools/list':
        listCount += 1
        if (options.failFirstListWith404 && listCount === 1) {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'missing session id' },
          }), { status: 404, headers: { 'content-type': 'application/json' } })
        }
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{
              name: 'echo',
              description: 'Echo text back',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            }],
          },
        })

      case 'tools/call':
        if (options.delayCallToolMs) await Bun.sleep(options.delayCallToolMs)
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        })

      default:
        return json({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'method not found' },
        })
    }
  }

  return {
    fetcher: fetchImpl,
    methods,
    initializeCount: () => initializeCount,
    listCount: () => listCount,
  }
}

const httpConfig = { type: 'http' as const, url: 'https://fake.local/mcp' }

describe('Pi MCP 连接管理（Streamable HTTP）', () => {
  test('Given a healthy server When listing and calling tools Then reuses one handshake and one session', async () => {
    const server = createFakeMcpServer()
    const manager = new PiMcpClientManager({ fetcher: server.fetcher })

    const tools = await manager.listTools('fake', httpConfig)
    expect(tools.map((tool) => tool.name)).toEqual(['echo'])

    const result = await manager.callTool('fake', httpConfig, 'echo', { text: 'hi' })
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(server.initializeCount()).toBe(1)

    await manager.dispose()
  })

  test('Given the server rejects the session When listing tools Then re-initializes once and recovers', async () => {
    const server = createFakeMcpServer({ failFirstListWith404: true })
    const manager = new PiMcpClientManager({ fetcher: server.fetcher })

    const tools = await manager.listTools('fake', httpConfig)

    expect(tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(server.initializeCount()).toBe(2)
    expect(server.listCount()).toBe(2)

    await manager.dispose()
  })

  test('Given an aborted tool call When the signal fires Then the connection is discarded and the next call re-handshakes', async () => {
    const server = createFakeMcpServer({ delayCallToolMs: 80 })
    const manager = new PiMcpClientManager({ fetcher: server.fetcher })

    await manager.listTools('fake', httpConfig)

    const controller = new AbortController()
    const pending = manager.callTool('fake', httpConfig, 'echo', {}, controller.signal)
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toBeDefined()

    // 远程连接在取消后被淘汰；下一次调用必须重新 initialize。
    const tools = await manager.listTools('fake', httpConfig)
    expect(tools).toHaveLength(1)
    expect(server.initializeCount()).toBe(2)

    await Bun.sleep(100)
    await manager.dispose()
  })

  test('Given dispose When a call follows Then performs a fresh handshake', async () => {
    const server = createFakeMcpServer()
    const manager = new PiMcpClientManager({ fetcher: server.fetcher })

    await manager.listTools('fake', httpConfig)
    await manager.dispose()

    const tools = await manager.listTools('fake', httpConfig)
    expect(tools).toHaveLength(1)
    expect(server.initializeCount()).toBe(2)

    await manager.dispose()
  })

  test('Given 系统网络 epoch 变化 When 再次调用 Then 等待就绪并淘汰旧连接', async () => {
    const server = createFakeMcpServer()
    let epoch = 0
    let readyCalls = 0
    const listeners: Array<() => void> = []
    const manager = new PiMcpClientManager({
      fetcher: server.fetcher,
      network: async () => ({
        ensureReady: async () => {
          readyCalls += 1
        },
        snapshot: () => ({ networkEpoch: epoch }),
        subscribe: (listener) => {
          listeners.push(listener)
          return () => undefined
        },
      }),
    })

    await manager.listTools('fake', httpConfig)
    expect(readyCalls).toBe(1)
    expect(server.initializeCount()).toBe(1)

    epoch = 1
    for (const listener of listeners) listener()
    await manager.listTools('fake', httpConfig)
    expect(server.initializeCount()).toBe(2)

    await manager.dispose()
  })

  test('Given a stdio server without command When listing tools Then keeps the existing skip behavior', async () => {
    const manager = new PiMcpClientManager()

    await expect(manager.listTools('local', { type: 'stdio' }))
      .rejects.toThrow('无法创建 MCP transport: local')

    await manager.dispose()
  })
})
