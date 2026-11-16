/**
 * 跨进程系统网络 fetch 解析。
 *
 * - main/browser：等待 `systemNetwork.ensureReady()` 后返回对应 scope 的 session fetch；
 * - utility：使用 Electron `net.fetch` 包装（utility 无主进程 session），
 *   仍共享协议/重定向/流规则。
 *
 * 调用方必须在请求前检查 AbortSignal，并在解析后再检查一次，避免等待代理配置
 * 期间用户已取消请求却继续发出网络请求。
 */

import type { NetworkFetchScope, SystemNetworkFetch } from './system-fetch'

export type HostSystemFetchResolver = (
  scope: NetworkFetchScope,
  signal?: AbortSignal,
) => Promise<SystemNetworkFetch>

function isUtilityProcess(): boolean {
  return (process as NodeJS.Process & { type?: string }).type === 'utility'
}

export async function getHostSystemFetch(
  scope: NetworkFetchScope,
  signal?: AbortSignal,
): Promise<SystemNetworkFetch> {
  if (isUtilityProcess()) {
    const { getUtilitySystemFetch } = await import('./system-fetch-utility')
    return getUtilitySystemFetch(scope)
  }
  const { getSystemFetch, systemNetwork } = await import('./system-network-runtime')
  await systemNetwork.ensureReady(signal)
  return getSystemFetch(scope)
}

/** 创建带取消语义的 host fetch；resolver 可注入用于测试或子进程代理。 */
export function createHostSystemFetch(
  scope: NetworkFetchScope,
  resolve: HostSystemFetchResolver = getHostSystemFetch,
): SystemNetworkFetch {
  return async (input, init) => {
    const signal = init?.signal
      ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const transport = await resolve(scope, signal ?? undefined)
    signal?.throwIfAborted()
    return transport(input, init)
  }
}
