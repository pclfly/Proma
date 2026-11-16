/**
 * Pi 协作收口扩展。
 *
 * 官方 0.22.0：父 Agent 在 `agent_before_settle` 时检查协作子会话是否仍未收敛；
 * 若仍有依赖，则以一条隐藏的 custom_message 把结果回填到同一轮并继续，
 * 避免父任务在子任务完成前报告成功。
 */

import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  SessionBoundaryDraft,
} from '@earendil-works/pi-coding-agent'

export const COLLABORATION_MESSAGE_TYPE = 'proma-collaboration-result'

const COLLABORATION_MAX_EXECUTIONS = 128

export interface CollaborationBoundaryDelivery {
  receipts: string[]
  text: string
}

export interface CollaborationBoundaryResult {
  pending: boolean
  reason?: string
  delivery?: CollaborationBoundaryDelivery
}

export interface CollaborationBoundaryRequest {
  receipts: string[]
  timeoutSeconds: number
  checkOnly?: boolean
}

export interface PiCollaborationBoundaryOptions {
  boundary: (request: CollaborationBoundaryRequest, signal: AbortSignal) => Promise<CollaborationBoundaryResult>
  signal: () => AbortSignal
  canContinue: () => boolean
  onWaiting?: (waiting: boolean) => void
}

interface SessionManagerLike {
  getBranch: () => unknown[]
}

interface CollaborationEntryLike {
  type?: unknown
  customType?: unknown
  details?: unknown
  message?: { role?: unknown; toolName?: unknown; details?: unknown }
}

interface ExtensionErrorLike {
  extensionPath?: unknown
  event?: unknown
  error?: unknown
}

function collectCollaborationReceipts(manager: SessionManagerLike): string[] {
  const receipts: string[] = []
  for (const rawEntry of manager.getBranch()) {
    const entry = rawEntry as CollaborationEntryLike
    const details = entry.type === 'custom_message' && entry.customType === COLLABORATION_MESSAGE_TYPE
      ? entry.details
      : entry.type === 'message'
        && entry.message?.role === 'toolResult'
        && typeof entry.message.toolName === 'string'
        && entry.message.toolName.startsWith('mcp__collaboration__')
        ? entry.message.details
        : undefined
    if (details && typeof details === 'object' && 'collaborationReceipts' in details) {
      const rawReceipts = (details as { collaborationReceipts?: unknown }).collaborationReceipts
      if (Array.isArray(rawReceipts)) {
        receipts.push(...rawReceipts.filter((value): value is string => typeof value === 'string'))
      }
    }
  }
  return [...new Set(receipts)]
}

export function createPiCollaborationBoundary(options: PiCollaborationBoundaryOptions) {
  let boundaryFailure: Error | undefined
  let continuations = 0

  return {
    extension: {
      name: 'proma-collaboration',
      hidden: true,
      factory(pi: ExtensionAPI): void {
        pi.on('agent_before_settle', async (event, ctx): Promise<AgentBeforeSettleEventResult | void> => {
          if (event.outcome !== 'completed' || options.signal().aborted || !options.canContinue()) return

          try {
            const receipts = collectCollaborationReceipts(ctx.sessionManager as unknown as SessionManagerLike)
            const state = await options.boundary({ receipts, timeoutSeconds: 0, checkOnly: true }, options.signal())
            if (!state.pending) return

            options.onWaiting?.(true)
            const result = await options.boundary({ receipts, timeoutSeconds: 7200 }, options.signal())
            if (!result.delivery || options.signal().aborted || !options.canContinue()) return
            if (++continuations > COLLABORATION_MAX_EXECUTIONS) {
              throw new Error(`协作自动续跑达到轮次上限（${COLLABORATION_MAX_EXECUTIONS}），请检查是否存在无进展循环`)
            }
            const entry = {
              type: 'custom_message',
              customType: COLLABORATION_MESSAGE_TYPE,
              content: result.delivery.text,
              display: false,
              details: { collaborationReceipts: result.delivery.receipts },
            } as SessionBoundaryDraft
            return {
              entries: [...event.entries, entry],
              continue: true,
            }
          } catch (error) {
            if (!options.signal().aborted) boundaryFailure = error instanceof Error ? error : new Error(String(error))
            throw error
          } finally {
            options.onWaiting?.(false)
          }
        })
      },
    },
    resetCycle(): void {
      continuations = 0
      boundaryFailure = undefined
    },
    captureError(error: ExtensionErrorLike): boolean {
      if (
        options.signal().aborted
        || (error.extensionPath !== '<inline:proma-collaboration>' && !(error.extensionPath === '<boundary>' && error.event === 'agent_before_settle'))
      ) {
        return false
      }
      boundaryFailure ??= new Error(`协作收敛失败：${String(error.error)}`)
      return true
    },
    async assertSettled(manager: SessionManagerLike): Promise<void> {
      if (boundaryFailure !== undefined) throw boundaryFailure
      if (options.signal().aborted) return
      const state = await options.boundary({
        receipts: collectCollaborationReceipts(manager),
        timeoutSeconds: 0,
        checkOnly: true,
      }, options.signal())
      if (state.pending) {
        throw new Error(state.reason ?? '协作依赖尚未收敛，当前父任务不能报告完成')
      }
    },
  }
}
