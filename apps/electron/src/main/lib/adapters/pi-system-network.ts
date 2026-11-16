/**
 * 延迟解析主进程/utility 进程的系统网络传输。
 *
 * 适配器在测试/CLI 环境中也会被导入，不能静态依赖 Electron 运行时；
 * 因此只在真正发起模型请求时动态加载，并在失败后允许下次重试。
 */

import type { ManagedWebSocketFactory } from './pi-system-websocket'
import type { PiSystemNetworkTransport } from './pi-system-fetch'

let resolved: Promise<PiSystemNetworkTransport> | undefined

function isUtilityProcess(): boolean {
  return (process as NodeJS.Process & { type?: string }).type === 'utility'
}

async function resolveCreateWebSocket(): Promise<ManagedWebSocketFactory> {
  if (isUtilityProcess()) {
    return () => {
      throw new Error('utility 进程暂不支持受管 WebSocket，请使用 SSE')
    }
  }
  const { createLocalSystemWebSocket, createSystemWebSocket } = await import('../network/system-network-runtime')
  const { codexWebSocketUrl } = await import('../network/websocket-protocol')
  return ((url: string, options?: unknown) => (
    url === codexWebSocketUrl()
      ? createLocalSystemWebSocket(url, options)
      : createSystemWebSocket(url, options)
  )) as ManagedWebSocketFactory
}

export function resolvePiModelSystemNetwork(): Promise<PiSystemNetworkTransport> {
  if (!resolved) {
    resolved = (async () => {
      const { getHostSystemFetch } = await import('../network/host-system-fetch')
      // main/browser 分支会等待 systemNetwork.ensureReady；utility 分支使用 net.fetch。
      const fetch = await getHostSystemFetch('model')
      return {
        fetch,
        createWebSocket: await resolveCreateWebSocket(),
      }
    })().catch((error) => {
      resolved = undefined
      throw error
    })
  }
  return resolved
}
