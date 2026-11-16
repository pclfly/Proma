/**
 * Utility/子进程侧的远程 WebSocket。
 *
 * 官方 0.22.0：本地对象实现 WebSocket 接口，实际连接由主进程 broker 持有；
 * 消息在 renderer 侧 ack 后释放待确认字节，关闭/错误统一映射为 DOM 语义。
 */

import { randomUUID } from 'node:crypto'
import type { WebSocketCommand, WebSocketNotice } from './websocket-broker'
import { MAX_SOCKET_BYTES, socketBytes, socketHeaders } from './websocket-protocol'

export type RemoteWebSocketConnector = (command: WebSocketCommand) => Promise<void>

class RemoteSocket extends EventTarget {
  readonly id = randomUUID()
  readonly url: string
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  protocol = ''
  extensions = ''
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private sending: Promise<void> = Promise.resolve()

  constructor(
    url: string,
    options: unknown,
    private readonly command: RemoteWebSocketConnector,
    private readonly register: (socket: RemoteSocket) => boolean,
    private readonly unregister: (id: string) => void,
    disposed: () => boolean,
  ) {
    super()
    this.url = url
    if (disposed() || !this.register(this)) throw new Error('模型网络租约不可用')
    const headers = socketHeaders(options)
    void command({ op: 'open', id: this.id, url, headers }).catch(() => this.fail())
  }

  private emit(event: Event): void {
    this.dispatchEvent(event)
    if (event.type === 'message') this.onmessage?.(event as MessageEvent)
    else if (event.type === 'open') this.onopen?.(event)
    else if (event.type === 'error') this.onerror?.(event)
    else if (event.type === 'close') this.onclose?.(event as CloseEvent)
  }

  receive(notice: WebSocketNotice): void {
    if (this.readyState === this.CLOSED) return
    if (notice.type === 'open') {
      if (this.readyState !== this.CONNECTING) return
      this.readyState = this.OPEN
      this.protocol = notice.protocol
      this.emit(new Event('open'))
    } else if (notice.type === 'message') {
      let data: string | ArrayBuffer | Blob
      if (typeof notice.data === 'string') {
        data = notice.data
      } else {
        const bytes = new Uint8Array(notice.data)
        data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes])
      }
      try {
        this.emit(new MessageEvent('message', { data }))
      } finally {
        void this.command({ op: 'ack', id: this.id, sequence: notice.sequence }).catch(() => this.fail())
      }
    } else if (notice.type === 'error') {
      this.emit(new Event('error'))
    } else {
      this.readyState = this.CLOSED
      this.bufferedAmount = 0
      this.unregister(this.id)
      this.emit(Object.assign(new Event('close'), {
        code: notice.code,
        reason: '',
        wasClean: notice.wasClean,
      }))
    }
  }

  fail(): void {
    if (this.readyState === this.CLOSED) return
    this.receive({ type: 'error', id: this.id })
    this.receive({ type: 'close', id: this.id, code: 1_006, wasClean: false })
    void this.command({ op: 'close', id: this.id, code: 1_000, reason: '' }).catch(() => undefined)
  }

  send(value: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== this.OPEN) throw new DOMException('WebSocket未连接', 'InvalidStateError')
    const size = typeof value === 'string'
      ? Buffer.byteLength(value)
      : value instanceof Blob
        ? value.size
        : value instanceof ArrayBuffer
          ? value.byteLength
          : value.byteLength
    if (this.bufferedAmount + size > MAX_SOCKET_BYTES) {
      this.fail()
      throw new Error('模型WebSocket发送缓冲已满')
    }
    this.bufferedAmount += size
    const snapshot = typeof value === 'string' || value instanceof Blob
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    this.sending = this.sending.then(async () => {
      const data = snapshot instanceof Blob ? new Uint8Array(await snapshot.arrayBuffer()) : snapshot
      if (this.readyState !== this.OPEN) return
      await this.command({ op: 'send', id: this.id, data })
    }).catch(() => this.fail()).finally(() => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - size)
    })
  }

  close(code = 1_000, reason = ''): void {
    if (code !== 1_000 && (code < 3_000 || code > 4_999)) {
      throw new DOMException('无效的WebSocket关闭码', 'InvalidAccessError')
    }
    if (socketBytes(reason) > 123) throw new DOMException('WebSocket关闭原因过长', 'SyntaxError')
    if (this.readyState >= this.CLOSING) return
    this.readyState = this.CLOSING
    void this.command({ op: 'close', id: this.id, code, reason }).then(() => {
      this.receive({ type: 'close', id: this.id, code, wasClean: true })
    }).catch(() => this.fail())
  }
}

export interface RemoteWebSockets {
  create: (url: string, options?: unknown) => WebSocket
  receive: (notice: WebSocketNotice) => void
  dispose: () => void
}

export function createRemoteWebSockets(command: RemoteWebSocketConnector): RemoteWebSockets {
  const sockets = new Map<string, RemoteSocket>()
  let disposed = false

  const register = (socket: RemoteSocket): boolean => {
    if (disposed || sockets.size >= 8) return false
    sockets.set(socket.id, socket)
    return true
  }
  const unregister = (id: string): void => {
    sockets.delete(id)
  }

  return {
    create: (url, options) => new RemoteSocket(
      url,
      options,
      command,
      register,
      unregister,
      () => disposed,
    ) as unknown as WebSocket,
    receive(notice) {
      sockets.get(notice.id)?.receive(notice)
    },
    dispose() {
      disposed = true
      for (const socket of sockets.values()) socket.fail()
    },
  }
}
