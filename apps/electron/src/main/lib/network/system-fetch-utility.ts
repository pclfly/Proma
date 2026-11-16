/**
 * Utility 进程的系统网络 fetch。
 *
 * Utility 进程没有主进程的 Electron Session 系统代理控制器，但 Electron
 * `net.fetch` 仍走 Chromium 网络栈。这里按 scope 缓存 transport，保持与主进程
 * 相同的协议校验、重定向策略与响应流包装。
 *
 * 该模块静态依赖 Electron，只能由 utility 分支动态加载；主进程/Bun 测试不要直接导入。
 */

import { net } from 'electron'
import {
  createUtilitySystemFetch,
  type NetworkFetchScope,
  type SystemNetworkFetch,
} from './system-fetch'
import {
  createUtilityFailureObserver,
  currentUtilityRouteEpochSource,
} from './utility-network-reporting'

const utilityTransports = new Map<NetworkFetchScope, SystemNetworkFetch>()

export function getUtilitySystemFetch(scope: NetworkFetchScope): SystemNetworkFetch {
  let transport = utilityTransports.get(scope)
  if (!transport) {
    transport = createUtilitySystemFetch(
      scope,
      (input, init) => net.fetch(input as string, init),
      scope === 'model' ? currentUtilityRouteEpochSource() : undefined,
      (signal) => createUtilityFailureObserver(scope, signal),
    )
    utilityTransports.set(scope, transport)
  }
  return transport
}

export const utilitySystemFetch = getUtilitySystemFetch('model')
