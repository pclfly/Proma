import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, AGENT_RUNTIME_PROTOCOL_VERSION } from '@proma/shared'

type MessageListener = (event: { data: unknown }) => void
interface RuntimeRequest { kind?: string; method: string; requestId: string; bootId: string; payload?: { queryId?: string } }

/** 只模拟 Electron utility 子进程通道；不启动真实进程、网络或用户数据。 */
class FakePort {
  private readonly listeners: MessageListener[] = []
  closed = false
  /** 模拟启动握手悬挂：只拦截 handshake，其余请求仍按正常协议回复。 */
  silenceHandshake = false
  /** 模拟握手被拒：仅让 handshake 回复失败。 */
  rejectHandshake = false
  postMessage(message: RuntimeRequest): void {
    if (message.kind !== 'request') return
    if (this.silenceHandshake && message.method === AGENT_RUNTIME_METHODS.HANDSHAKE) return
    queueMicrotask(() => this.respond(message))
  }
  on(_event: 'message', listener: MessageListener): void { this.listeners.push(listener) }
  start(): void {}
  close(): void { this.closed = true }
  private respond(message: RuntimeRequest): void {
    const handshake = message.method === AGENT_RUNTIME_METHODS.HANDSHAKE
    if (handshake && this.rejectHandshake) {
      const failure = {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: message.bootId, kind: 'response',
        method: message.method, requestId: message.requestId, ok: false,
        error: { code: 'runtime.handshake_failed', message: 'fixture handshake failure' },
      }
      for (const listener of this.listeners) listener({ data: failure })
      return
    }
    const bootId = handshake ? 'boot-1' : message.bootId
    const payload = handshake
      ? {
          runtimeVersion: 'fixture',
          pid: 4242,
          capabilities: [],
          state: { status: 'ready', bootId: 'boot-1', pid: 4242, active: false, pendingRequests: 0 },
        }
      : { accepted: true, completed: true }
    const response = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      bootId,
      kind: 'response',
      method: message.method,
      requestId: message.requestId,
      ok: true,
      payload,
    }
    for (const listener of this.listeners) listener({ data: response })
  }
}

class FakeProcess {
  private readonly exitListeners: Array<(code: number) => void> = []
  killCount = 0
  killResult = true
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === 'exit') this.exitListeners.push(listener as unknown as (code: number) => void)
  }
  postMessage(): void {}
  kill(): boolean { this.killCount += 1; return this.killResult }
  emitExit(code = 0): void { for (const listener of this.exitListeners) listener(code) }
}

let port: FakePort
let child: FakeProcess

mock.module('electron', () => ({
  MessageChannelMain: class {
    port1 = port
    port2 = port
  },
  utilityProcess: { fork: () => child },
}))

const { AgentRuntimeClient, AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE } = await import('./agent-runtime-client')

function setup(exitConfirmTimeoutMs = 1_000) {
  port = new FakePort()
  child = new FakeProcess()
  return new AgentRuntimeClient({ sessionId: 'fixture-session', exitConfirmTimeoutMs })
}

beforeEach(() => {
  port = new FakePort()
  child = new FakeProcess()
})

describe('utility 进程真实退出屏障', () => {
  test('Given SHUTDOWN已接受但子进程尚未exit When stop Then 不把kill请求当作已退出', async () => {
    const client = setup()
    await client.start()
    let settled = false
    const stopping = client.stop().then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(child.killCount).toBe(1)
    expect(settled).toBe(false)
    child.emitExit(0)
    await stopping
    expect(settled).toBe(true)
  })

  test('Given 子进程始终不发exit When stop Then 以退出未确认失败而不是假报收尾', async () => {
    const client = setup(20)
    await client.start()
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
    // 失败后同一 client 不能悄悄恢复成可安全收尾。
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
  })

  test('Given kill返回false且没有exit When stop Then 同样拒绝而不用超时宣称完成', async () => {
    const client = setup(20)
    await client.start()
    child.killResult = false
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
  })

  test('Given 并发stop When 同一个子进程退出 Then 共用一次屏障与一次kill', async () => {
    const client = setup()
    await client.start()
    const first = client.stop()
    const second = client.stop()
    expect(second).toBe(first)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(child.killCount).toBe(1)
    child.emitExit(0)
    await Promise.all([first, second])
  })

  test('Given 正常退出后重复stop When 再次调用 Then 不重复kill也不报未确认', async () => {
    const client = setup()
    await client.start()
    const stopping = client.stop()
    child.emitExit(0)
    await stopping
    await client.stop()
    expect(child.killCount).toBe(1)
  })
})

describe('启动窗口内的退出证据', () => {
  test('Given 握手仍挂着且子进程不exit When stop Then 拒绝而不是假报收尾', async () => {
    const client = setup(20)
    port.silenceHandshake = true
    const starting = client.start()
    void starting.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
    await starting.catch(() => {})
  })

  test('Given 启动被取消且子进程不exit When 再次stop Then 不再假装已收尾', async () => {
    const client = setup(20)
    port.silenceHandshake = true
    const starting = client.start()
    void starting.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
    await starting.catch(() => {})
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
    expect(child.killCount).toBeGreaterThan(0)
  })

  test('Given 握手自身失败且子进程不exit When 启动与stop Then 仍标记退出未确认', async () => {
    const client = setup(20)
    port.rejectHandshake = true
    await expect(client.start()).rejects.toThrow('handshake')
    await expect(client.stop()).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
    expect(child.killCount).toBeGreaterThan(0)
  })

  test('Given 握手失败清理期间stop When 启动已拒绝 Then 不提前当成收尾', async () => {
    const client = setup(20)
    port.rejectHandshake = true
    const starting = client.start()
    void starting.catch(() => {})
    const stopping = client.stop()
    void stopping.catch(() => {})
    await expect(starting).rejects.toThrow()
    await expect(stopping).rejects.toMatchObject({ code: AGENT_RUNTIME_EXIT_UNCONFIRMED_CODE })
  })
})
