import { describe, expect, test } from 'bun:test'
import type { Dispatcher } from 'undici'
import { closePiRequestProxyDispatcher } from './pi-request-proxy'

describe('Pi 请求 dispatcher 清理契约', () => {
  test('Given dispatcher异步关闭失败 When query严格关闭 Then 错误上浮而不是伪装成功', async () => {
    const dispatcher = { close: async () => { throw new Error('fixture close failure') } } as unknown as Dispatcher
    await expect(closePiRequestProxyDispatcher(dispatcher, { strict: true })).rejects.toThrow('fixture close failure')
  })
  test('Given 没有专用dispatcher When 严格关闭 Then 正常结束不操作全局连接池', async () => {
    await closePiRequestProxyDispatcher(undefined, { strict: true })
  })
})
