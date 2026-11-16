import { describe, expect, test } from 'bun:test'
import type { CloudFetch } from '@proma/cloud'
import { createCloudFetchRunner, withCloudFetch } from './cloud-network-service'

describe('Cloud 网络执行器', () => {
  test('Given 注入 fetch When 执行工作 Then 工作拿到同一函数', async () => {
    const injected: CloudFetch = async () => new Response('ok')
    const runner = createCloudFetchRunner(injected)
    const received = await runner(async (fetchFn) => fetchFn)
    expect(received).toBe(injected)
  })

  test('Given 默认执行器 When 执行工作 Then 使用 globalThis.fetch', async () => {
    const received = await withCloudFetch(async (fetchFn) => fetchFn)
    expect(received).toBe(globalThis.fetch)
  })
})
