import { describe, expect, test } from 'bun:test'
import type { VaultPresentationResult } from '@proma/shared'
import { buildVaultTools, type VaultPresentationLike } from './pi-vault-tools'

interface TestTool {
  name: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }>
}

const sdk = {
  defineTool: (tool: TestTool) => tool,
} as unknown as typeof import('@earendil-works/pi-coding-agent')

function tools(ctx: Parameters<typeof buildVaultTools>[1], presentation?: VaultPresentationLike): TestTool[] {
  return buildVaultTools(sdk, ctx, presentation) as unknown as TestTool[]
}

describe('Pi VaultOpen 工具', () => {
  test('Given 用户会话 When 构建 Then 暴露 VaultOpen 并透传展示结果', async () => {
    const calls: unknown[] = []
    const presentation: VaultPresentationLike = {
      async present(sessionId, input, signal): Promise<VaultPresentationResult> {
        calls.push({ sessionId, input, aborted: signal?.aborted ?? false })
        return { requestId: 'req', status: 'opened' }
      },
    }
    const [tool] = tools({ sessionId: 'session-1', triggeredBy: 'user' }, presentation)
    expect(tool?.name).toBe('VaultOpen')
    const result = await tool!.execute('call', { relativePath: 'Notes/a.md', kind: 'file' })
    expect(calls).toEqual([{
      sessionId: 'session-1',
      input: { relativePath: 'Notes/a.md', kind: 'file' },
      aborted: false,
    }])
    expect(result.details).toEqual({ requestId: 'req', status: 'opened' })
  })

  test('Given 自动化/委派或 Vault 关闭 When 构建 Then 不注入工具', () => {
    expect(tools({ sessionId: 's', triggeredBy: 'automation' })).toEqual([])
    expect(tools({ sessionId: 's', triggeredBy: 'delegation' })).toEqual([])
    expect(tools({ sessionId: 's', triggeredBy: 'user', productivityTools: { obsidianEnabled: false } }))
      .toEqual([])
  })

  test('Given 展示服务未初始化 When 调用 Then 返回 unavailable 而不抛错', async () => {
    const [tool] = tools({ sessionId: 's', triggeredBy: 'user' }, undefined)
    const result = await tool!.execute('call', {})
    expect(result.details).toEqual({
      status: 'unavailable',
      message: 'Vault 展示服务尚未初始化',
    })
  })
})
