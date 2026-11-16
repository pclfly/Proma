/**
 * 浏览器会话系统网络门禁。
 *
 * 官方 0.22.0：浏览器 WebContents 使用系统代理前，先等待系统网络策略就绪；
 * 每个 networkEpoch 只应用一次代理配置，后续 epoch 强制刷新，避免旧路由滞留。
 */

export interface BrowserNetworkSession {
  setProxy: (config: { mode: 'system' }) => Promise<void>
  forceReloadProxyConfig: () => Promise<void>
}

export interface BrowserNetworkSource {
  ensureReady: () => Promise<void>
  snapshot: () => { networkEpoch: number }
}

export interface BrowserNetworkGate {
  (session: BrowserNetworkSession): Promise<void>
}

interface SessionNetworkState {
  epoch: number
  pending: Promise<void>
}

const GATE_TIMEOUT_MS = 5_000

export function createBrowserNetworkGate(network: BrowserNetworkSource): BrowserNetworkGate {
  const states = new WeakMap<BrowserNetworkSession, SessionNetworkState>()
  return async (session) => {
    await network.ensureReady()
    const epoch = network.snapshot().networkEpoch
    let state = states.get(session)
    if (!state || state.epoch !== epoch) {
      const previous = state
      const pending = (async () => {
        await previous?.pending.catch(() => undefined)
        if (!previous) await session.setProxy({ mode: 'system' })
        else await session.forceReloadProxyConfig()
      })()
      state = { epoch, pending }
      states.set(session, state)
      void pending.catch(() => {
        if (states.get(session) === state) states.delete(session)
      })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        state.pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('浏览器系统网络策略超时')), GATE_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

let gate: BrowserNetworkGate | undefined

/** 浏览器入口使用：首次调用时懒加载系统网络运行时。 */
export async function ensureBrowserSystemNetwork(
  session: BrowserNetworkSession,
): Promise<void> {
  if (!gate) {
    const runtime = await import('./system-network-runtime')
    gate = createBrowserNetworkGate(runtime.systemNetwork)
  }
  await gate(session)
}
