/**
 * Pi 模型请求的系统网络路由。
 *
 * 官方 0.22.0：Pi SDK 直接使用全局 fetch；Proma 用 AsyncLocalStorage 在
 * `streamFunction` 作用域内把 fetch 切换到系统网络，避免污染同一 Agent loop
 * 中的 MCP/工具请求。未进入作用域时仍调用原 fetch（本地渠道代理保持生效）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SystemNetworkFetch } from '../network/system-network-service'
import { runWithPiSystemWebSocket, type ManagedWebSocketFactory } from './pi-system-websocket'

let installed = false
const scopedFetch = new AsyncLocalStorage<SystemNetworkFetch>()

export function installPiSystemFetch(): void {
  if (installed) return
  installed = true
  const fallback = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const transport = scopedFetch.getStore() ?? fallback
    return transport(input, init)
  }) as typeof globalThis.fetch
}

export function runWithPiSystemFetch<T>(
  transport: SystemNetworkFetch,
  operation: () => Promise<T>,
): Promise<T> {
  installPiSystemFetch()
  return scopedFetch.run(transport, operation)
}

export interface PiSystemNetworkTransport {
  fetch: SystemNetworkFetch
  createWebSocket: ManagedWebSocketFactory
}

/** 同一 provider stream 内同时切换 HTTP 与 WebSocket。 */
export function runWithPiSystemNetwork<T>(
  network: PiSystemNetworkTransport,
  operation: () => Promise<T>,
): Promise<T> {
  return runWithPiSystemWebSocket(
    network.createWebSocket,
    () => runWithPiSystemFetch(network.fetch, operation),
  )
}
