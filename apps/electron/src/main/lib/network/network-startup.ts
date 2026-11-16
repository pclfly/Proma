/**
 * 网络启动门禁。
 *
 * 官方 0.22.0：系统网络策略就绪前，依赖网络的初始化任务先登记；
 * 策略就绪后按登记顺序异步执行，单个任务失败只记录错误，不阻断启动。
 */

export interface NetworkStartupGate {
  add: (name: string, work: () => void | Promise<void>) => void
  setReady: (ready: boolean) => void
}

export function createNetworkStartupGate(
  onError: (name: string) => void,
): NetworkStartupGate {
  let ready = false
  const registered = new Set<string>()
  const pending = new Map<string, () => void | Promise<void>>()

  function flush(): void {
    if (!ready) return
    for (const [name, work] of pending) {
      pending.delete(name)
      void Promise.resolve().then(work).catch(() => onError(name))
    }
  }

  return {
    add(name, work) {
      if (registered.has(name)) return
      registered.add(name)
      pending.set(name, work)
      flush()
    },
    setReady(value) {
      ready = value
      flush()
    },
  }
}
