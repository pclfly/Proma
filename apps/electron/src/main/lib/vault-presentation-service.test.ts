import { describe, expect, test } from 'bun:test'
import type { VaultPresentationRequest, VaultPresentationResult } from '@proma/shared'
import { createVaultPresentationService } from './vault-presentation-service'

interface FakeWindow {
  webContents: { id: number; isDestroyed(): boolean; send(channel: string, payload: unknown): void }
  isDestroyed(): boolean
}

function makeHarness(options: {
  enabled?: boolean
  identity?: { vaultId: string; configuredAt: number } | null
  timeoutMs?: number
  validateTarget?: (
    identity: { vaultId: string; configuredAt: number },
    target: { kind: 'file' | 'folder'; relativePath: string },
  ) => Promise<{ kind: 'file' | 'folder'; relativePath: string }>
} = {}) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let enabled = options.enabled ?? true
  let identity = options.identity === undefined ? { vaultId: 'v1', configuredAt: 100 } : options.identity
  let destroyed = false

  const window: FakeWindow = {
    webContents: {
      id: 7,
      isDestroyed: () => destroyed,
      send: (channel, payload) => { sent.push({ channel, payload }) },
    },
    isDestroyed: () => destroyed,
  }

  const service = createVaultPresentationService({
    getWindow: () => (destroyed ? undefined : (window as unknown as { webContents: never; isDestroyed(): boolean })),
    isEnabled: () => enabled,
    getIdentity: () => identity,
    validateTarget: options.validateTarget ?? (async (_identity, target) => target),
    send: (channel, payload) => {
      if (destroyed) return
      sent.push({ channel: channel === 'request' ? 'request' : 'cancel', payload })
    },
    timeoutMs: options.timeoutMs ?? 50,
  })

  return {
    service,
    sent,
    setEnabled: (value: boolean) => { enabled = value },
    setIdentity: (value: { vaultId: string; configuredAt: number } | null) => { identity = value },
    destroy: () => { destroyed = true },
    webContentsId: 7,
  }
}

function lastRequest(sent: Array<{ channel: string; payload: unknown }>): VaultPresentationRequest {
  const hit = [...sent].reverse().find((s) => s.channel === 'request')
  if (!hit) throw new Error('未发送任何展示请求')
  return hit.payload as VaultPresentationRequest
}

describe('Vault 展示服务：前置校验', () => {
  test('Given Vault 功能关闭 When 展示 Then blocked 且不发送请求', async () => {
    const h = makeHarness({ enabled: false })
    const result = await h.service.present('s1')
    expect(result.status).toBe('blocked')
    expect(result.message).toContain('已关闭')
    expect(h.sent).toHaveLength(0)
  })

  test('Given 缺少 sessionId When 展示 Then blocked', async () => {
    const h = makeHarness()
    expect((await h.service.present('')).status).toBe('blocked')
  })

  test('Given kind 非法 When 展示 Then blocked', async () => {
    const h = makeHarness()
    expect((await h.service.present('s1', { kind: 'note', relativePath: 'a.md' })).status).toBe('blocked')
  })

  test('Given 指定 kind 但无 relativePath When 展示 Then blocked', async () => {
    const h = makeHarness()
    expect((await h.service.present('s1', { kind: 'file' })).status).toBe('blocked')
  })

  test('Given 未配置 Vault When 展示 Then unavailable 且不自动选择', async () => {
    const h = makeHarness({ identity: null })
    const result = await h.service.present('s1')
    expect(result.status).toBe('unavailable')
    expect(result.message).toContain('不会自动选择或切换')
    expect(h.sent).toHaveLength(0)
  })

  test('Given 目标校验失败 When 展示 Then blocked 且不发送请求', async () => {
    const h = makeHarness({
      validateTarget: async () => { throw new Error('Vault 展示目标不存在') },
    })
    const result = await h.service.present('s1', { relativePath: 'missing.md' })
    expect(result.status).toBe('blocked')
    expect(result.message).toContain('不存在')
    expect(h.sent).toHaveLength(0)
  })

  test('Given 校验过程中 Vault 被切换 When 展示 Then blocked', async () => {
    const h = makeHarness({
      validateTarget: async (_identity: { vaultId: string; configuredAt: number }, target: { kind: 'file' | 'folder'; relativePath: string }) => {
        h.setIdentity({ vaultId: 'v2', configuredAt: 200 })
        return target
      },
    })
    const result = await h.service.present('s1', { relativePath: 'a.md' })
    expect(result.status).toBe('blocked')
    expect(h.sent).toHaveLength(0)
  })
})

describe('Vault 展示服务：握手与回执', () => {
  test('Given 合法请求 When 展示 Then 发送带身份与目标的请求', async () => {
    const h = makeHarness()
    const promise = h.service.present('s1', { relativePath: 'note.md' })
    await Bun.sleep(1)
    const request = lastRequest(h.sent)
    expect(request).toMatchObject({ sessionId: 's1', vaultId: 'v1', configuredAt: 100 })
    expect(request.target).toEqual({ kind: 'file', relativePath: 'note.md' })

    await h.service.complete(h.webContentsId, { requestId: request.requestId, status: 'opened' })
    expect((await promise).status).toBe('opened')
  })

  test('Given 未回执 When 超时 Then unavailable 且发送取消', async () => {
    const h = makeHarness({ timeoutMs: 20 })
    const result = await h.service.present('s1')
    expect(result.status).toBe('unavailable')
    expect(result.message).toContain('超时')
    expect(h.sent.some((s) => s.channel === 'cancel')).toBe(true)
    expect(h.service.pendingCount()).toBe(0)
  })

  test('Given 非主窗口回执 When complete Then 抛错', async () => {
    const h = makeHarness()
    const promise = h.service.present('s1')
    await Bun.sleep(1)
    const request = lastRequest(h.sent)
    await expect(h.service.complete(999, { requestId: request.requestId, status: 'opened' })).rejects.toThrow('仅当前主窗口')
    await h.service.complete(h.webContentsId, { requestId: request.requestId, status: 'opened' })
    await promise
  })

  test('Given 回执 status 非法 When complete Then 抛错且请求仍悬挂', async () => {
    const h = makeHarness({ timeoutMs: 30 })
    const promise = h.service.present('s1')
    await Bun.sleep(1)
    const request = lastRequest(h.sent)
    await expect(h.service.complete(h.webContentsId, { requestId: request.requestId, status: 'done' })).rejects.toThrow('非法')
    const result = await promise
    expect(result.status).toBe('unavailable')
  })

  test('Given 回执 message 过长 When complete Then 抛错', async () => {
    const h = makeHarness({ timeoutMs: 30 })
    const promise = h.service.present('s1')
    await Bun.sleep(1)
    const request = lastRequest(h.sent)
    await expect(
      h.service.complete(h.webContentsId, { requestId: request.requestId, status: 'blocked', message: 'x'.repeat(2001) }),
    ).rejects.toThrow('非法')
    await promise
  })

  test('Given 回执前 Vault 已切换 When complete Then 回 blocked 并发送取消', async () => {
    const h = makeHarness()
    const promise = h.service.present('s1', { relativePath: 'a.md' })
    await Bun.sleep(1)
    const request = lastRequest(h.sent)
    h.setIdentity({ vaultId: 'v2', configuredAt: 300 })
    await h.service.complete(h.webContentsId, { requestId: request.requestId, status: 'opened' })
    const result = await promise
    expect(result.status).toBe('blocked')
    expect(h.sent.some((s) => s.channel === 'cancel')).toBe(true)
  })

  test('Given 未知 requestId When complete Then 静默忽略', async () => {
    const h = makeHarness()
    await h.service.complete(h.webContentsId, { requestId: 'nope', status: 'opened' })
    expect(h.service.pendingCount()).toBe(0)
  })
})

describe('Vault 展示服务：取消与隔离', () => {
  test('Given 会话取消 When cancelSession Then 该会话请求全部 unavailable', async () => {
    const h = makeHarness()
    const a = h.service.present('s1')
    await Bun.sleep(1)
    h.service.cancelSession('s1')
    expect((await a).status).toBe('unavailable')
  })

  test('Given 取消某会话 When 另一会话仍有请求 Then 不受影响', async () => {
    const h = makeHarness()
    const a = h.service.present('s1')
    await Bun.sleep(1)
    const b = h.service.present('s2')
    await Bun.sleep(1)
    h.service.cancelSession('s1')
    expect((await a).status).toBe('unavailable')
    expect(h.service.pendingCount()).toBe(1)
    h.service.cancelSession('s2')
    await b
  })

  test('Given signal 已中止 When 展示 Then unavailable 且不发请求', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    controller.abort()
    const result = await h.service.present('s1', {}, controller.signal)
    expect(result.status).toBe('unavailable')
    expect(h.sent).toHaveLength(0)
  })

  test('Given 展示中 signal 中止 When 触发 Then unavailable 并取消', async () => {
    const h = makeHarness({ timeoutMs: 1_000 })
    const controller = new AbortController()
    const promise = h.service.present('s1', {}, controller.signal)
    await Bun.sleep(1)
    controller.abort()
    const result = await promise
    expect(result.status).toBe('unavailable')
    expect(h.service.pendingCount()).toBe(0)
  })

  test('Given 主窗口已销毁 When 展示 Then unavailable 且不发送', async () => {
    const h = makeHarness()
    h.destroy()
    const result = await h.service.present('s1')
    expect(result.status).toBe('unavailable')
    expect(result.message).toContain('主窗口不可用')
  })
})
