import { afterAll, describe, expect, mock, test } from 'bun:test'
import { createHostSystemFetch } from './host-system-fetch'
import type { SystemNetworkFetch } from './system-fetch'

const transport: SystemNetworkFetch = async () => new Response('ok')

afterAll(() => {
  mock.restore()
})

describe('Host 系统网络 fetch', () => {
  test('Given 正常请求 When 解析完成 Then 使用对应 scope 的 transport', async () => {
    const calls: Array<{ scope: string; input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchFn = createHostSystemFetch('model', async (scope) => {
      expect(scope).toBe('model')
      return async (input, init) => {
        calls.push({ scope, input, init })
        return new Response('model-ok')
      }
    })
    const response = await fetchFn('https://example.com/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(await response.text()).toBe('model-ok')
    expect(calls[0]?.scope).toBe('model')
    expect(calls[0]?.input).toBe('https://example.com/v1')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  test('Given 已取消信号 When 调用 Then 解析器与 transport 都不执行', async () => {
    let resolved = false
    let transported = false
    const controller = new AbortController()
    controller.abort()
    const fetchFn = createHostSystemFetch('cloud', async () => {
      resolved = true
      return async () => {
        transported = true
        return new Response('ok')
      }
    })
    await expect(fetchFn('https://example.com', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(resolved).toBe(false)
    expect(transported).toBe(false)
  })

  test('Given 解析期间取消 When 解析返回 Then 不发出请求', async () => {
    let transported = false
    const controller = new AbortController()
    const fetchFn = createHostSystemFetch('oauth', async (_scope, signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return async () => {
        transported = true
        return new Response('ok')
      }
    })
    await expect(fetchFn('https://example.com', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(transported).toBe(false)
  })

  test('Given Request 自带信号 When 调用 Then 解析器收到同一信号', async () => {
    const controller = new AbortController()
    const request = new Request('https://example.com', { signal: controller.signal })
    const fetchFn = createHostSystemFetch('model', async (_scope, signal) => {
      expect(signal).toBe(controller.signal)
      return transport
    })
    await expect(fetchFn(request)).resolves.toBeInstanceOf(Response)
  })

  test('Given 主进程 When getHostSystemFetch Then 等待 ensureReady 后返回 scope fetch', async () => {
    const events: string[] = []
    mock.module('./system-network-runtime', () => ({
      systemNetwork: {
        ensureReady: async (signal?: AbortSignal) => {
          events.push(`ready:${signal ? 'signal' : 'none'}`)
        },
      },
      getSystemFetch: (scope: string) => {
        events.push(`fetch:${scope}`)
        return transport
      },
    }))
    const { getHostSystemFetch } = await import('./host-system-fetch')
    const controller = new AbortController()
    const resolved = await getHostSystemFetch('mcp', controller.signal)
    expect(resolved).toBe(transport)
    expect(events).toEqual(['ready:signal', 'fetch:mcp'])
  })
})

describe('Utility 进程系统网络 fetch', () => {
  test('Given Electron net.fetch When 获取 transport Then 按 scope 缓存并复用网络规则', async () => {
    const netFetch = mock(async (input: string, _init?: RequestInit) => new Response(`net:${input}`))
    mock.module('electron', () => ({ net: { fetch: netFetch } }))
    const utility = await import('./system-fetch-utility')
    const fetchFn = utility.getUtilitySystemFetch('mcp')
    expect(utility.getUtilitySystemFetch('mcp')).toBe(fetchFn)
    expect(utility.getUtilitySystemFetch('cloud')).not.toBe(fetchFn)

    const response = await fetchFn('https://example.com/api', {
      headers: { Authorization: 'Bearer token' },
    })
    expect(await response.text()).toBe('net:https://example.com/api')
    const [input, init] = netFetch.mock.calls[0] ?? []
    expect(input).toBe('https://example.com/api')
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      bypassCustomProtocolHandlers: true,
    })

    const modelResponse = await utility.utilitySystemFetch('https://api.example.com')
    expect(await modelResponse.text()).toBe('net:https://api.example.com')
    expect(netFetch.mock.calls[1]?.[0]).toBe('https://api.example.com')
  })
})
