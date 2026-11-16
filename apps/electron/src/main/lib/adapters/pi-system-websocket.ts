/**
 * Pi 模型 WebSocket 的系统网络路由。
 *
 * 官方 0.22.0：Codex 等 provider 可能直接 `new WebSocket(...)`。
 * 这里用 AsyncLocalStorage + Proxy 只在 provider stream 作用域内把构造调用
 * 导向主进程受管 WebSocket；作用域外的 WebSocket 行为保持不变。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type ManagedWebSocketFactory = (
  url: string,
  options?: unknown,
) => WebSocket

interface WebSocketScope {
  create?: ManagedWebSocketFactory
}

const scope = new AsyncLocalStorage<WebSocketScope>()
let installed: { WebSocket: typeof WebSocket; run: <T>(create: ManagedWebSocketFactory | undefined, operation: () => T) => T } | undefined

function createScopedWebSocketRouter(fallback: typeof WebSocket) {
  const RoutedWebSocket = new Proxy(fallback, {
    construct(target, args, newTarget) {
      const current = scope.getStore()
      if (!current) return Reflect.construct(target, args, newTarget)
      if (!current.create) {
        throw new Error('当前运行环境尚未提供受管 WebSocket 连接，请使用 SSE 或等待兼容支持。')
      }
      return current.create(String(args[0]), args[1])
    },
  })
  return {
    WebSocket: RoutedWebSocket,
    run<T>(create: ManagedWebSocketFactory | undefined, operation: () => T): T {
      return scope.run({ create }, operation)
    },
  }
}

export function runWithPiSystemWebSocket<T>(
  create: ManagedWebSocketFactory | undefined,
  operation: () => T,
): T {
  if (!installed && typeof globalThis.WebSocket === 'function') {
    installed = createScopedWebSocketRouter(globalThis.WebSocket)
    globalThis.WebSocket = installed.WebSocket
  }
  return installed ? installed.run(create, operation) : operation()
}
