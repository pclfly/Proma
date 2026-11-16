import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWebSocketBroker, type BrokerSocket, type WebSocketNotice } from './websocket-broker'
import { createRemoteWebSockets } from './remote-websocket'
import { createBridgeSocketFactory, NodeStyleSystemSocket } from './bridge-websocket'
import { codexWebSocketUrl, socketBytes, socketHeaders } from './websocket-protocol'
import { createBridgeHttp } from './bridge-http'

class FakeSocket implements BrokerSocket {
  binaryType = 'blob'
  protocol = 'proto'
  readyState = 1
  bufferedAmount = 0
  sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = []
  closed: number[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((item) => item !== listener))
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob, _callback?: (error?: Error) => void): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closed.push(code ?? 1_000)
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const allowedUrl = 'wss://chatgpt.com/backend-api/codex/responses'

describe('WebSocket 协议辅助', () => {
  test('Given Codex HTTP 端点 When 转换 Then 得到 ws/wss 且拒绝凭据', () => {
    expect(codexWebSocketUrl('https://chatgpt.com/backend-api')).toBe('wss://chatgpt.com/backend-api/codex/responses')
    expect(codexWebSocketUrl('https://example.com/codex')).toBe('wss://example.com/codex/responses')
    expect(() => codexWebSocketUrl('https://user:pass@example.com')).toThrow('无效')
  })

  test('Given 握手头或数据 When 计算 Then 限制头部与字节数', () => {
    expect(socketHeaders({ headers: { Authorization: 'Bearer x' } })).toEqual({ authorization: 'Bearer x' })
    expect(socketBytes('你好')).toBe(6)
    expect(socketBytes(new Uint8Array([1, 2, 3]))).toBe(3)
  })
})

describe('WebSocket broker', () => {
  function createBroker() {
    let epoch = 0
    const listeners = new Set<() => void>()
    const notices: WebSocketNotice[] = []
    const sockets: FakeSocket[] = []
    const broker = createWebSocketBroker({
      allowedUrl,
      ensureReady: async () => undefined,
      epoch: () => epoch,
      create: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      notify: (notice) => notices.push(notice),
    })
    return {
      broker,
      notices,
      sockets,
      setEpoch(value: number) {
        epoch = value
        for (const listener of listeners) listener()
      },
    }
  }

  test('Given 授权目标 When open/message/ack/send Then 转发通知与数据', async () => {
    const harness = createBroker()
    await harness.broker.command({ op: 'open', id: 's1', url: allowedUrl, headers: {} })
    harness.sockets[0]!.emit('open')
    harness.sockets[0]!.emit('message', { data: 'hello' })
    harness.sockets[0]!.emit('message', { data: new Uint8Array([1, 2]) })
    expect(harness.notices.map((notice) => notice.type)).toEqual(['open', 'message', 'message'])
    expect((harness.notices[1] as { sequence: number }).sequence).toBe(1)
    await harness.broker.command({ op: 'ack', id: 's1', sequence: 1 })
    await harness.broker.command({ op: 'send', id: 's1', data: 'hi' })
    expect(harness.sockets[0]!.sent).toEqual(['hi'])
    harness.broker.dispose()
  })

  test('Given 未授权目标或重复 ID When open Then 拒绝', async () => {
    const harness = createBroker()
    await expect(harness.broker.command({ op: 'open', id: 's1', url: 'wss://evil.example' }))
      .rejects.toThrow('未授权')
    await harness.broker.command({ op: 'open', id: 's1', url: allowedUrl, headers: {} })
    await expect(harness.broker.command({ op: 'open', id: 's1', url: allowedUrl, headers: {} }))
      .rejects.toThrow('未授权')
    harness.broker.dispose()
  })

  test('Given epoch 变化 When 连接空闲 Then 关闭并通知', async () => {
    const harness = createBroker()
    await harness.broker.command({ op: 'open', id: 's1', url: allowedUrl, headers: {} })
    harness.setEpoch(1)
    expect(harness.sockets[0]!.closed).toEqual([1_000])
    expect(harness.notices.at(-1)).toMatchObject({ type: 'close', id: 's1' })
    harness.broker.dispose()
  })
})

describe('远程 WebSocket', () => {
  test('Given 命令通道 When open/message/send Then DOM 事件与 ack 正确', async () => {
    const commands: Array<{ op: string; id: string; sequence?: number; data?: string | Uint8Array }> = []
    const remote = createRemoteWebSockets(async (command) => {
      commands.push(command as never)
    })
    const socket = remote.create(allowedUrl) as unknown as {
      readyState: number
      send: (data: string) => void
      close: (code?: number) => void
    }
    const id = (socket as unknown as { id: string }).id
    remote.receive({ type: 'open', id, protocol: 'p' })
    expect(socket.readyState).toBe(1)
    let message = ''
    ;(socket as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage = (event) => {
      message = String(event.data)
    }
    remote.receive({ type: 'message', id, sequence: 1, data: 'hello' })
    expect(message).toBe('hello')
    socket.send('world')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(commands.some((command) => command.op === 'ack' && command.sequence === 1)).toBe(true)
    expect(commands.some((command) => command.op === 'send' && command.data === 'world')).toBe(true)
    socket.close(1_000)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(commands.some((command) => command.op === 'close')).toBe(true)
    remote.dispose()
  })
})

describe('Bridge WebSocket', () => {
  test('Given epoch 变化 When 工厂创建的 socket Then 关闭旧连接', () => {
    let epoch = 0
    let listener: (() => void) | undefined
    const sockets: FakeSocket[] = []
    const factory = createBridgeSocketFactory({
      create: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      epoch: () => epoch,
      subscribe: (next) => {
        listener = next
        return () => undefined
      },
    })
    factory(allowedUrl)
    epoch = 1
    listener?.()
    expect(sockets[0]!.closed).toEqual([1_000])
  })

  test('Given NodeStyleSystemSocket When message Then 输出 Buffer 与 binary 标记', () => {
    const socket = new FakeSocket()
    const wrapped = new NodeStyleSystemSocket(socket)
    const events: Array<[Buffer, boolean]> = []
    wrapped.on('message', (data: Buffer, binary: boolean) => events.push([data, binary]))
    socket.emit('message', { data: 'text' })
    socket.emit('message', { data: new Uint8Array([1, 2]) })
    expect(events[0]?.[0].toString()).toBe('text')
    expect(events[0]?.[1]).toBe(false)
    expect(events[1]?.[1]).toBe(true)
  })
})

describe('系统网络运行时接线', () => {
  test('Given runtime When 创建本地 WebSocket Then 使用 broker + remote + 协议白名单', () => {
    const runtime = readFileSync(join(import.meta.dir, 'system-network-runtime.ts'), 'utf8')
    expect(runtime).toContain("from './remote-websocket'")
    expect(runtime).toContain("from './websocket-broker'")
    expect(runtime).toContain('createLocalSystemWebSocket')
    expect(runtime).toContain('codexWebSocketUrl()')
    const adapter = readFileSync(join(import.meta.dir, '..', 'adapters', 'pi-system-network.ts'), 'utf8')
    expect(adapter).toContain('createLocalSystemWebSocket')
    expect(adapter).toContain('createSystemWebSocket')
    const bridge = readFileSync(join(import.meta.dir, 'bridge-network.ts'), 'utf8')
    expect(bridge).toContain("createHostSystemFetch('model')")
    expect(bridge).toContain('createBridgeSocketFactory')
  })
})

describe('Bridge HTTP', () => {
  test('Given 注入 fetch When axios GET Then 使用注入 transport', async () => {
    const calls: string[] = []
    const client = createBridgeHttp(async (input) => {
      calls.push(input instanceof Request ? input.url : String(input))
      return new Response('ok', { status: 200 })
    })
    const response = await client.get('https://example.com/test')
    expect(response.data).toBe('ok')
    expect(calls).toEqual(['https://example.com/test'])
  })
})
