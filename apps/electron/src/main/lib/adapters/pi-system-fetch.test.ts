import { afterAll, describe, expect, test } from 'bun:test'
import { installPiSystemFetch, runWithPiSystemFetch, runWithPiSystemNetwork } from './pi-system-fetch'

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const calls: string[] = []

// 路由安装后 globalThis.fetch 就是路由本身，不能在测试之间再次替换。
globalThis.fetch = (async (input: RequestInfo | URL) => {
  calls.push(`fallback:${String(input)}`)
  return new Response('fallback')
}) as unknown as typeof fetch
installPiSystemFetch()

afterAll(() => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
})

describe('Pi 模型请求系统 fetch 路由', () => {
  test('Given 未进入作用域 When 调用 fetch Then 使用原 fetch', async () => {
    calls.length = 0
    const response = await fetch('https://fallback.example/')
    expect(await response.text()).toBe('fallback')
    expect(calls).toEqual(['fallback:https://fallback.example/'])
  })

  test('Given 进入作用域 When 异步调用 fetch Then 使用系统 transport', async () => {
    calls.length = 0
    const response = await runWithPiSystemFetch(async (input) => {
      calls.push(`system:${String(input)}`)
      return new Response('system')
    }, async () => {
      await Promise.resolve()
      return globalThis.fetch('https://system.example/')
    })
    expect(await response.text()).toBe('system')
    expect(calls).toEqual(['system:https://system.example/'])
  })

  test('Given 进入网络作用域 When new WebSocket Then 使用受管连接', async () => {
    class FakeWebSocket {
      url: string
      constructor(url: string) {
        this.url = url
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const result = await runWithPiSystemNetwork({
      fetch: async () => new Response('ok'),
      createWebSocket: (url) => ({ managed: url }) as unknown as WebSocket,
    }, async () => new WebSocket('wss://managed.example/'))
    expect((result as unknown as { managed: string }).managed).toBe('wss://managed.example/')
  })

  test('Given 已安装 WebSocket 路由器 When 作用域外构造 Then 回到原构造器', () => {
    class FakeWebSocket {
      url: string
      constructor(url: string) {
        this.url = url
      }
    }
    // 路由器已在上一用例安装，这里只验证作用域外回退；原构造器是首次安装时捕获的 Fake。
    const socket = new WebSocket('wss://outside.example/') as unknown as FakeWebSocket
    expect(socket.url).toBe('wss://outside.example/')
  })

  test('Given 两个并发作用域 When 同时请求 Then transport 不串线', async () => {
    calls.length = 0
    const left = runWithPiSystemFetch(async (input) => {
      await Promise.resolve()
      calls.push(`left:${String(input)}`)
      return new Response('left')
    }, async () => {
      await Promise.resolve()
      return globalThis.fetch('https://left.example/')
    })
    const right = runWithPiSystemFetch(async (input) => {
      calls.push(`right:${String(input)}`)
      return new Response('right')
    }, async () => {
      await Promise.resolve()
      return globalThis.fetch('https://right.example/')
    })
    await Promise.all([left, right])
    expect(calls.sort()).toEqual([
      'left:https://left.example/',
      'right:https://right.example/',
    ])
  })
})
