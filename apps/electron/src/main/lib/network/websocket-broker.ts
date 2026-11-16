/**
 * 模型 WebSocket broker。
 *
 * 官方 0.22.0：主进程持有真实 socket，utility 只发命令/收通知；
 * 按 networkEpoch 淘汰旧连接，限制并发连接数、单帧和待确认字节，
 * 旧路由半开时由 stall watchdog 主动失败。
 */

import { createStallWatchdog } from './stall-watchdog'
import { MAX_SOCKET_BYTES, socketBytes } from './websocket-protocol'

export type WebSocketNotice =
  | { type: 'open'; id: string; protocol: string }
  | { type: 'message'; id: string; sequence: number; data: string | Uint8Array }
  | { type: 'error'; id: string }
  | { type: 'close'; id: string; code: number; wasClean: boolean }

export type WebSocketCommand =
  | { op: 'open'; id: string; url: string; headers?: HeadersInit }
  | { op: 'send'; id: string; data: string | Uint8Array }
  | { op: 'ack'; id: string; sequence: number }
  | { op: 'close'; id: string; code?: number; reason?: string }

export interface BrokerSocket {
  binaryType: string
  protocol: string
  readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void
  removeEventListener: (type: string, listener: (event: unknown) => void) => void
}

export interface WebSocketBrokerDependencies {
  allowedUrl: string
  ensureReady: () => Promise<void>
  epoch: () => number
  routeEpoch?: () => number | undefined
  create: (url: string, headers: Record<string, string>) => BrokerSocket
  subscribe: (listener: () => void) => () => void
  notify: (notice: WebSocketNotice) => void
  maxPendingBytes?: number
  stallMs?: number
  stallTickMs?: number
}

interface BrokerEntry {
  socket: BrokerSocket
  epoch: number
  busy: boolean
  retired: boolean
  sequence: number
  pending: Map<number, number>
  watchdog?: ReturnType<typeof createStallWatchdog>
  cleanup: () => void
}

const MAX_SOCKETS = 8
const MAX_HANDSHAKE_HEADER_BYTES = 64 * 1024

export function createWebSocketBroker(dependencies: WebSocketBrokerDependencies) {
  const byteLimit = dependencies.maxPendingBytes ?? MAX_SOCKET_BYTES
  const sockets = new Map<string, BrokerEntry>()
  const opening = new Set<string>()
  let disposed = false
  let pendingBytes = 0

  const notify = (notice: WebSocketNotice): void => {
    if (!disposed) dependencies.notify(notice)
  }

  const remove = (id: string, entry: BrokerEntry): void => {
    if (sockets.get(id) !== entry) return
    sockets.delete(id)
    for (const size of entry.pending.values()) pendingBytes -= size
    entry.pending.clear()
    entry.watchdog?.stop()
    entry.cleanup()
  }

  const close = (id: string, entry: BrokerEntry, code = 1_000): void => {
    remove(id, entry)
    try {
      entry.socket.close(code)
    } catch {
      // socket 已关闭时忽略。
    }
    notify({ type: 'close', id, code, wasClean: code === 1_000 })
  }

  const fail = (id: string, entry: BrokerEntry): void => {
    notify({ type: 'error', id })
    close(id, entry, 4_000)
  }

  const unsubscribe = dependencies.subscribe(() => {
    for (const [id, entry] of sockets) {
      if (entry.epoch === dependencies.epoch()) continue
      entry.retired = true
      if (!entry.busy) close(id, entry)
    }
  })

  return {
    async command(command: WebSocketCommand): Promise<void> {
      if (disposed) throw new Error('模型网络租约已结束')
      if (!command || typeof command !== 'object' || typeof command.id !== 'string' || command.id.length > 100) {
        throw new Error('无效的socket命令')
      }

      if (command.op === 'open') {
        if (
          command.url !== dependencies.allowedUrl
          || sockets.has(command.id)
          || opening.has(command.id)
          || sockets.size + opening.size >= MAX_SOCKETS
        ) {
          throw new Error('未授权的模型WebSocket目标或租约')
        }
        opening.add(command.id)
        try {
          await dependencies.ensureReady()
        } catch {
          opening.delete(command.id)
          throw new Error('系统网络尚未就绪')
        }
        const cancelled = !opening.delete(command.id)
        if (disposed || cancelled || sockets.has(command.id) || sockets.size >= MAX_SOCKETS) {
          throw new Error('模型网络租约已结束')
        }
        const headers = Object.fromEntries(new Headers(command.headers))
        if (Buffer.byteLength(JSON.stringify(headers)) > MAX_HANDSHAKE_HEADER_BYTES) {
          throw new Error('WebSocket握手头过大')
        }
        const socket = dependencies.create(command.url, headers)
        socket.binaryType = 'arraybuffer'
        const entry: BrokerEntry = {
          socket,
          epoch: dependencies.epoch(),
          busy: false,
          retired: false,
          sequence: 0,
          pending: new Map(),
          cleanup: () => undefined,
        }
        const id = command.id
        const onOpen = (): void => notify({ type: 'open', id, protocol: socket.protocol })
        const onMessage = (event: unknown): void => {
          const value = event && typeof event === 'object' && 'data' in event
            ? (event as { data?: unknown }).data
            : undefined
          let data: string | Uint8Array
          if (typeof value === 'string') data = value
          else if (value instanceof ArrayBuffer) data = new Uint8Array(value)
          else if (ArrayBuffer.isView(value)) data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          else {
            fail(id, entry)
            return
          }
          const size = socketBytes(data)
          if (size > byteLimit || pendingBytes + size > byteLimit) {
            fail(id, entry)
            return
          }
          pendingBytes += size
          entry.sequence += 1
          entry.pending.set(entry.sequence, size)
          entry.watchdog?.progress()
          notify({ type: 'message', id, sequence: entry.sequence, data })
          if (typeof data === 'string') {
            try {
              const payload: unknown = JSON.parse(data)
              if (
                payload
                && typeof payload === 'object'
                && 'type' in payload
                && ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(String((payload as { type: unknown }).type))
              ) {
                entry.busy = false
                entry.watchdog?.stop()
                entry.watchdog = undefined
                if (entry.retired) close(id, entry)
              }
            } catch {
              // 非 JSON 业务帧无需结束忙碌状态。
            }
          }
        }
        const onError = (): void => fail(id, entry)
        const onClose = (event: unknown): void => {
          remove(id, entry)
          const code = event && typeof event === 'object' && 'code' in event && typeof (event as { code: unknown }).code === 'number'
            ? (event as { code: number }).code
            : 1_006
          const wasClean = Boolean(event && typeof event === 'object' && 'wasClean' in event && (event as { wasClean: unknown }).wasClean === true)
          notify({ type: 'close', id, code, wasClean })
        }
        entry.cleanup = () => {
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('message', onMessage)
          socket.removeEventListener('error', onError)
          socket.removeEventListener('close', onClose)
        }
        sockets.set(id, entry)
        socket.addEventListener('open', onOpen)
        socket.addEventListener('message', onMessage)
        socket.addEventListener('error', onError)
        socket.addEventListener('close', onClose)
        return
      }

      const entry = sockets.get(command.id)
      if (!entry) {
        if (command.op === 'close') opening.delete(command.id)
        if (command.op === 'close' || command.op === 'ack') return
        throw new Error('模型WebSocket已关闭')
      }

      if (command.op === 'ack') {
        const size = entry.pending.get(command.sequence)
        if (size !== undefined) {
          pendingBytes -= size
          entry.pending.delete(command.sequence)
        }
      } else if (command.op === 'close') {
        const code = command.code === 1_000 || (command.code !== undefined && command.code >= 3_000 && command.code <= 4_999)
          ? command.code
          : 1_000
        close(command.id, entry, code)
      } else if (command.op === 'send') {
        if (typeof command.data !== 'string' && !(command.data instanceof Uint8Array)) {
          throw new Error('无效的WebSocket数据')
        }
        if (entry.retired || entry.epoch !== dependencies.epoch() || entry.socket.readyState !== 1) {
          throw new Error('模型网络已变化，本次帧未发送')
        }
        if (socketBytes(command.data) > MAX_SOCKET_BYTES) throw new Error('模型WebSocket帧过大')
        entry.busy = true
        if (dependencies.routeEpoch && !entry.watchdog) {
          const id = command.id
          entry.watchdog = createStallWatchdog({
            routeEpoch: dependencies.routeEpoch,
            stallMs: dependencies.stallMs,
            tickMs: dependencies.stallTickMs,
            onStall: () => {
              if (sockets.get(id) === entry) fail(id, entry)
            },
          })
        }
        try {
          entry.socket.send(command.data)
        } catch {
          fail(command.id, entry)
          throw new Error('模型WebSocket发送失败')
        }
      } else {
        throw new Error('无效的socket命令')
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      opening.clear()
      unsubscribe()
      for (const [id, entry] of sockets) close(id, entry)
    },
  }
}
