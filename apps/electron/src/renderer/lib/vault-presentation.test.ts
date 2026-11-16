import { describe, expect, test } from 'bun:test'
import type { VaultPresentationRequest, VaultPresentationResult } from '@proma/shared'
import { handleVaultPresentationRequest } from './vault-presentation'

function request(overrides: Partial<VaultPresentationRequest> = {}): VaultPresentationRequest {
  return { requestId: 'req-1', sessionId: 'session-1', vaultId: 'vault-1', configuredAt: 1, ...overrides }
}

describe('Vault 展示请求的渲染端处理', () => {
  test('Given 可展示视图且路由成功 When 处理 Then 回执 opened', async () => {
    const acks: VaultPresentationResult[] = []
    const result = await handleVaultPresentationRequest(request(), {
      getState: () => ({ canPresent: true }),
      present: () => true,
      ack: async (r) => { acks.push(r) },
    })
    expect(result.status).toBe('opened')
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ requestId: 'req-1', status: 'opened' })
  })

  test('Given 不可展示视图 When 处理 Then 回执 queued 且不调用路由', async () => {
    let routed = 0
    const result = await handleVaultPresentationRequest(request(), {
      getState: () => ({ canPresent: false }),
      present: () => { routed++; return true },
      ack: async () => {},
    })
    expect(result.status).toBe('queued')
    expect(result.message).toContain('用户返回后')
    expect(routed).toBe(0)
  })

  test('Given 可展示但路由失败 When 处理 Then 回执 blocked 而非假装打开', async () => {
    const result = await handleVaultPresentationRequest(request(), {
      getState: () => ({ canPresent: true }),
      present: () => false,
      ack: async () => {},
    })
    expect(result.status).toBe('blocked')
  })

  test('Given 任何请求 When 处理 Then 必须回执一次', async () => {
    for (const canPresent of [true, false]) {
      let count = 0
      await handleVaultPresentationRequest(request(), {
        getState: () => ({ canPresent }),
        present: () => true,
        ack: async () => { count++ },
      })
      expect(count).toBe(1)
    }
  })

  test('Given 请求带目标 When 处理 Then 原样回执同一 requestId', async () => {
    const acks: VaultPresentationResult[] = []
    await handleVaultPresentationRequest(
      request({ requestId: 'abc', target: { kind: 'file', relativePath: 'a.md' } }),
      { getState: () => ({ canPresent: true }), present: () => true, ack: async (r) => { acks.push(r) } },
    )
    expect(acks[0]!.requestId).toBe('abc')
  })

  test('Given 回执失败 When 处理 Then 不吞错但结果仍返回', async () => {
    const result = await handleVaultPresentationRequest(request(), {
      getState: () => ({ canPresent: true }),
      present: () => true,
      ack: async () => { throw new Error('ipc down') },
    }).catch((error: unknown) => error)
    // 回执失败会让整个处理抛出；这是有意的，避免"假成功"被当成已展示。
    expect(result).toBeInstanceOf(Error)
  })
})
