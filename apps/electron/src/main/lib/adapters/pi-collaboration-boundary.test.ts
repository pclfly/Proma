import { describe, expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  COLLABORATION_MESSAGE_TYPE,
  createPiCollaborationBoundary,
  type CollaborationBoundaryRequest,
  type CollaborationBoundaryResult,
} from './pi-collaboration-boundary'

type BoundaryHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>

function setup(boundary: (request: CollaborationBoundaryRequest, signal: AbortSignal) => Promise<CollaborationBoundaryResult>, options: {
  aborted?: boolean
  canContinue?: boolean
} = {}) {
  let handler: BoundaryHandler | undefined
  const pi = {
    on: (_event: string, next: BoundaryHandler) => {
      handler = next
      return () => {}
    },
  } as unknown as ExtensionAPI
  const controller = new AbortController()
  if (options.aborted) controller.abort()
  const boundaryExtension = createPiCollaborationBoundary({
    boundary,
    signal: () => controller.signal,
    canContinue: () => options.canContinue ?? true,
  })
  boundaryExtension.extension.factory(pi)
  return { handler: handler!, boundaryExtension }
}

describe('Pi 协作收口扩展', () => {
  test('Given 仍有运行中的委派 When before settle Then 追加隐藏结果消息并继续', async () => {
    const requests: CollaborationBoundaryRequest[] = []
    const { handler } = setup(async (request) => {
      requests.push(request)
      if (request.checkOnly) return { pending: true, reason: 'running' }
      return {
        pending: false,
        delivery: { receipts: ['del-1:1:success'], text: 'result text' },
      }
    })
    const result = await handler({ outcome: 'completed', entries: [] }, {
      sessionManager: { getBranch: () => [] },
    }) as { entries: Array<Record<string, unknown>>; continue: boolean }

    expect(requests[0]?.checkOnly).toBe(true)
    expect(requests[1]?.timeoutSeconds).toBe(7200)
    expect(result.continue).toBe(true)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      type: 'custom_message',
      customType: COLLABORATION_MESSAGE_TYPE,
      display: false,
      content: 'result text',
    })
  })

  test('Given 没有待收敛委派 When before settle Then 不续跑', async () => {
    const { handler } = setup(async () => ({ pending: false }))
    expect(await handler({ outcome: 'completed', entries: [] }, {
      sessionManager: { getBranch: () => [] },
    })).toBeUndefined()
  })

  test('Given 已取消或不能继续 When before settle Then 不检查 boundary', async () => {
    let called = 0
    const { handler } = setup(async () => { called += 1; return { pending: true } }, { aborted: true })
    await handler({ outcome: 'completed', entries: [] }, { sessionManager: { getBranch: () => [] } })
    expect(called).toBe(0)

    const second = setup(async () => { called += 1; return { pending: true } }, { canContinue: false })
    await second.handler({ outcome: 'completed', entries: [] }, { sessionManager: { getBranch: () => [] } })
    expect(called).toBe(0)
  })

  test('Given 历史 custom message 含凭据 When 收口 Then 去重后传给 boundary', async () => {
    let seen: string[] = []
    const { handler } = setup(async (request) => {
      seen = request.receipts
      return { pending: false }
    })
    await handler({ outcome: 'completed', entries: [] }, {
      sessionManager: {
        getBranch: () => [
          { type: 'custom_message', customType: COLLABORATION_MESSAGE_TYPE, details: { collaborationReceipts: ['r1', 'r1', 'r2'] } },
          { type: 'message', message: { role: 'toolResult', toolName: 'mcp__collaboration__wait_for_delegations', details: { collaborationReceipts: ['r2', 'r3'] } } },
        ],
      },
    })
    expect(seen).toEqual(['r1', 'r2', 'r3'])
  })

  test('Given boundary 仍 pending When assertSettled Then 拒绝报告完成', async () => {
    const { boundaryExtension } = setup(async () => ({ pending: true, reason: '仍有子任务' }))
    await expect(boundaryExtension.assertSettled({ getBranch: () => [] })).rejects.toThrow('仍有子任务')
  })
})
