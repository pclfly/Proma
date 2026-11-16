/**
 * Bridge 系统网络适配层。
 *
 * 官方 0.22.0：Bridge HTTP 走 systemNetwork model scope；WebSocket 走受管
 * system WebSocket 工厂，并按 networkEpoch 自动退役旧连接。
 */

import { createHostSystemFetch } from './host-system-fetch'
import { createBridgeSocketFactory, NodeStyleSystemSocket, type BridgeSocket } from './bridge-websocket'
import type { SystemNetworkFetch } from './system-network-service'

const managedFetch = createHostSystemFetch('model')

/** Bridge HTTP fetch：120s 超时，并保留调用方 signal。 */
export const bridgeFetch: SystemNetworkFetch = async (input, init) => {
  const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(parent ? [parent] : []),
  ])
  return managedFetch(input, { ...init, signal })
}

export interface BridgeNetworkOptions {
  idleMs?: number
  retireOnEpoch?: boolean
}

export interface BridgeNetwork {
  fetch: SystemNetworkFetch
  webSocketFactory: (url: string, headers?: Record<string, string>) => BridgeSocket
  nodeWebSocketFactory: (url: string, headers?: Record<string, string>) => NodeStyleSystemSocket
}

export async function getBridgeNetwork(options: BridgeNetworkOptions = {}): Promise<BridgeNetwork> {
  const { createSystemWebSocket, systemNetwork } = await import('./system-network-runtime')
  await systemNetwork.ensureReady()
  const webSocketFactory = createBridgeSocketFactory({
    create: (url, headers) => createSystemWebSocket(url, { headers }) as unknown as BridgeSocket,
    epoch: () => systemNetwork.snapshot().networkEpoch,
    subscribe: (listener) => systemNetwork.subscribe(() => listener()),
  }, options)
  return {
    fetch: bridgeFetch,
    webSocketFactory,
    nodeWebSocketFactory: (url, headers) => new NodeStyleSystemSocket(webSocketFactory(url, headers)),
  }
}
