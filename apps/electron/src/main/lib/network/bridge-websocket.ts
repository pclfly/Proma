/**
 * Bridge 使用的受管 WebSocket。
 *
 * 官方 0.22.0：按 networkEpoch 退役旧连接，握手/空闲超时自动重建；
 * 同时提供 Node EventEmitter 风格的适配器，兼容 Slack/DingTalk SDK。
 */

import { EventEmitter } from 'node:events'

export interface BridgeSocket {
  binaryType: string
  readyState: number
  bufferedAmount: number
  protocol: string
  send: (data: string | ArrayBuffer | ArrayBufferView | Blob, callback?: (error?: Error) => void) => void
  close: (code?: number, reason?: string) => void
  addEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void
  removeEventListener: (type: string, listener: (event: unknown) => void) => void
}

export interface BridgeSocketFactoryDependencies {
  create: (url: string, headers: Record<string, string>) => BridgeSocket
  epoch: () => number
  subscribe: (listener: () => void) => () => void
}

export interface BridgeSocketFactoryOptions {
  idleMs?: number
  retireOnEpoch?: boolean
}

export function createBridgeSocketFactory(
  dependencies: BridgeSocketFactoryDependencies,
  options: BridgeSocketFactoryOptions = {},
): (url: string, headers?: Record<string, string>) => BridgeSocket {
  return (url, headers = {}) => {
    const socket = dependencies.create(url, headers)
    socket.binaryType = 'arraybuffer'
    const epoch = dependencies.epoch()
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const renew = (): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      unsubscribe()
      socket.close()
    }
    const arm = (): void => {
      clearTimeout(timer)
      const idleMs = options.idleMs ?? 5 * 60_000
      if (idleMs > 0 && !closed) timer = setTimeout(renew, idleMs)
    }
    const unsubscribe = dependencies.subscribe(() => {
      if (options.retireOnEpoch !== false && dependencies.epoch() !== epoch) renew()
    })
    timer = setTimeout(renew, 10_000)
    socket.addEventListener('open', arm)
    socket.addEventListener('message', arm)
    socket.addEventListener('close', () => {
      closed = true
      clearTimeout(timer)
      unsubscribe()
      socket.removeEventListener('open', arm)
      socket.removeEventListener('message', arm)
    }, { once: true })
    return socket
  }
}

export class NodeStyleSystemSocket extends EventEmitter {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  constructor(private readonly socket: BridgeSocket) {
    super()
    socket.addEventListener('open', () => this.emit('open'))
    socket.addEventListener('message', (event) => {
      const data = event && typeof event === 'object' && 'data' in event
        ? (event as { data?: unknown }).data
        : undefined
      const bytes = typeof data === 'string'
        ? Buffer.from(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : undefined
      if (!bytes || bytes.byteLength > 16 * 1024 * 1024) {
        this.reportError(new Error('系统WebSocket收到不支持或超限的数据'))
        socket.close()
        return
      }
      this.emit('message', bytes, typeof data !== 'string')
    })
    socket.addEventListener('error', () => {
      this.reportError(new Error('系统WebSocket连接失败，请检查系统网络'))
    })
    socket.addEventListener('close', (event) => {
      const code = event && typeof event === 'object' && 'code' in event && typeof (event as { code: unknown }).code === 'number'
        ? (event as { code: number }).code
        : 1_006
      this.emit('close', code, Buffer.alloc(0))
    })
  }

  private reportError(error: Error): void {
    if (this.listenerCount('error')) this.emit('error', error)
  }

  get readyState(): number {
    return this.socket.readyState
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }

  /** Chromium 没有裸 socket 销毁接口；close 在 CONNECTING 阶段会终止握手。 */
  terminate(): void {
    this.socket.close()
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob, callback?: (error?: Error) => void): void {
    try {
      if (this.readyState !== NodeStyleSystemSocket.OPEN) throw new Error('WebSocket尚未打开或已经关闭')
      const bytes = typeof data === 'string'
        ? Buffer.byteLength(data)
        : data instanceof Blob
          ? data.size
          : data instanceof ArrayBuffer
            ? data.byteLength
            : data.byteLength
      if (this.bufferedAmount + bytes > 8 * 1024 * 1024) {
        throw new Error('系统WebSocket发送队列超过上限')
      }
      this.socket.send(data)
      if (callback) queueMicrotask(() => callback())
    } catch {
      const safeError = new Error('系统WebSocket无法发送数据')
      if (callback) queueMicrotask(() => callback(safeError))
      else throw safeError
    }
  }
}
