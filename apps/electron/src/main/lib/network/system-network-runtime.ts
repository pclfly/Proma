/**
 * 系统网络运行时单例。
 *
 * 官方 0.22.0 的接线方式：
 * - `systemNetwork` 管理 5 个 Electron session 的系统代理策略；
 * - 默认 session 在策略未就绪时禁止访问外网，仅放行 localhost；
 * - 网络恢复观察器监听系统唤醒、接口变化和代理策略变化；
 * - 诊断记录与恢复调度共用同一个 networkEpoch。
 */

import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { app, BrowserWindow, net, powerMonitor, session } from 'electron'
import { NETWORK_IPC_CHANNELS } from '@proma/shared'
import { createNetworkDiagnostics } from './network-diagnostics'
import { createRemoteWebSockets } from './remote-websocket'
import { createWebSocketBroker } from './websocket-broker'
import { codexWebSocketUrl } from './websocket-protocol'
import { createNetworkChangeMonitor, createNetworkRecovery } from './network-recovery'
import { createNetworkStartupGate } from './network-startup'
import { createChromiumFetch } from './system-fetch'
import {
  createSystemNetworkService,
  type SystemNetworkFetch,
  type SystemNetworkScope,
  type SystemNetworkSession,
} from './system-network-service'

export const networkStartup = createNetworkStartupGate((name) => {
  console.warn(`[网络] 后台服务初始化未完成：${name}`)
})

let hasConfiguredSystemNetwork = false
let routeEpoch = 0
const routeListeners = new Set<() => void>()

export function getRouteEpoch(): number {
  return routeEpoch
}

export function subscribeRouteChange(listener: () => void): () => void {
  routeListeners.add(listener)
  return () => {
    routeListeners.delete(listener)
  }
}

function markRouteChanged(): void {
  routeEpoch += 1
  for (const listener of routeListeners) {
    try {
      listener()
    } catch {
      // 路由订阅者异常不能阻断网络恢复。
    }
  }
}

export const systemNetwork = createSystemNetworkService({
  onTransportFailure: (error) => networkRecovery.notify('transport-error', error),
  async configureUtility() {
    await app.whenReady()
    const appWithProxy = app as unknown as {
      setProxy: (config: { mode: 'system' }) => Promise<void>
    }
    await Promise.all([
      appWithProxy.setProxy({ mode: 'system' }),
      session.defaultSession.setProxy({ mode: 'system' }),
    ])
  },
  async clearDefaultHostCache() {
    await session.defaultSession.clearHostResolverCache()
  },
  createSession(scope: SystemNetworkScope): SystemNetworkSession {
    const target = session.fromPartition(`proma-network-${scope}`)
    return {
      setProxy: (config) => target.setProxy(config),
      forceReloadProxyConfig: () => target.forceReloadProxyConfig(),
      clearHostResolverCache: () => target.clearHostResolverCache(),
      // 仅模型请求启用路由变化后的停滞检测；MCP SSE 等长连接允许长时间空闲。
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => createChromiumFetch(
        (request, options) => target.fetch(request as string, options),
        undefined,
        scope === 'model' ? { routeEpochSource: () => getRouteEpoch() } : {},
      )(input, init)) as SystemNetworkSession['fetch'],
    }
  },
  onChange(snapshot) {
    if (snapshot.status === 'ready') hasConfiguredSystemNetwork = true
    networkStartup.setReady(snapshot.status === 'ready')
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(NETWORK_IPC_CHANNELS.STATUS_CHANGED, snapshot)
      }
    }
  },
})

export const networkDiagnostics = createNetworkDiagnostics({
  fetch: (input, init) => getSystemFetch('cloud')(input, init),
  snapshot: () => systemNetwork.snapshot(),
  clientVersion: app.getVersion(),
  platform: process.platform,
})

export const networkRecovery = createNetworkRecovery({
  recover: (reason) => systemNetwork.recover(reason),
  onFailure: () => {
    console.warn('[网络] 系统网络恢复未完成，登录状态已保留')
  },
})

export function getSystemFetch(scope: SystemNetworkScope = 'cloud'): SystemNetworkFetch {
  return systemNetwork.getFetch(scope)
}

/** Codex 等模型的 WebSocket 必须复用系统网络 session，且只允许 ws/wss。 */
export function createSystemWebSocket(
  url: string,
  options?: unknown,
): WebSocket {
  const target = new URL(url)
  if (
    !hasConfiguredSystemNetwork
    || !['wss:', 'ws:'].includes(target.protocol)
    || target.username
    || target.password
  ) {
    throw new Error('系统WebSocket策略尚未就绪或目标无效')
  }
  const headers = options && typeof options === 'object' && 'headers' in options
    ? (options as { headers?: Record<string, string> }).headers
    : undefined
  return new net.WebSocket(url, {
    ...(headers ? { headers } : {}),
    session: session.fromPartition('proma-network-model'),
    useSessionCookies: false,
  }) as unknown as WebSocket
}

/**
 * Codex 模型 WebSocket 的本地代理：utility 侧使用 RemoteSocket，
 * 主进程 broker 持有真实 net.WebSocket。
 */
export function createLocalSystemWebSocket(url: string, options?: unknown): WebSocket {
  if (url !== codexWebSocketUrl()) throw new Error('未授权的模型WebSocket目标')
  const remote = createRemoteWebSockets((command) => broker.command(command))
  const broker = createWebSocketBroker({
    allowedUrl: url,
    ensureReady: () => systemNetwork.ensureReady(),
    epoch: () => systemNetwork.snapshot().networkEpoch,
    routeEpoch: getRouteEpoch,
    create: (target, headers) => createSystemWebSocket(target, { headers }) as never,
    subscribe: (listener) => systemNetwork.subscribe(() => listener()),
    notify: (notice) => {
      queueMicrotask(() => remote.receive(notice))
      if (notice.type === 'close') broker.dispose()
    },
  })
  try {
    return remote.create(url, options)
  } catch (error) {
    broker.dispose()
    remote.dispose()
    throw error
  }
}

/**
 * 默认 session 外网闸门：策略未就绪时只允许 localhost。
 * 浏览器与渲染进程的远程请求都必须等系统代理配置完成。
 */
export function installDefaultSessionNetworkGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const hostname = new URL(details.url).hostname
      const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
      callback({ cancel: !hasConfiguredSystemNetwork && !local })
    },
  )
}

let recoveryInstalled = false

export function installNetworkRecoveryObservers(): void {
  if (recoveryInstalled) return
  recoveryInstalled = true

  const resume = (): void => {
    markRouteChanged()
    networkRecovery.notify('resume')
  }
  powerMonitor.on('resume', resume)

  let proxyFingerprint: string | undefined
  let proxyProbe: Promise<void> | undefined
  let disposed = false
  let stopMonitor: (() => void) | undefined
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

  networkStartup.add('network-observer', () => {
    if (disposed) return
    stopMonitor = createNetworkChangeMonitor({
      async sample() {
        proxyProbe ??= Promise.all(
          ['https://api.proma.cool', 'https://api.openai.com', 'https://api.anthropic.com']
            .map((url) => session.defaultSession.resolveProxy(url)),
        ).then((routes) => {
          if (disposed) return
          const next = hash(JSON.stringify(routes))
          if (proxyFingerprint !== undefined && next !== proxyFingerprint) {
            networkRecovery.notify('policy-change')
          }
          proxyFingerprint = next
        }).catch(() => undefined).finally(() => {
          proxyProbe = undefined
        })
        return hash(JSON.stringify([net.isOnline(), networkInterfaces()]))
      },
      onChange: () => {
        markRouteChanged()
        networkRecovery.notify('policy-change')
      },
    })
  })

  app.once('will-quit', () => {
    disposed = true
    stopMonitor?.()
    powerMonitor.removeListener('resume', resume)
    networkRecovery.dispose()
  })
}

export async function initializeSystemNetwork(): Promise<void> {
  await systemNetwork.initialize()
}
