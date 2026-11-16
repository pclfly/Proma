/**
 * Vault 展示服务：把「右侧 Vault 标签要显示哪篇笔记」的意图，从 Agent 传到渲染进程。
 *
 * 设计约束（对齐官方 0.21.45-01）：
 * - 只表达「展示」意图，不读文件、不编辑、不创建、不归档、不切换 Vault。
 * - 渲染进程必须回执确认，主进程才认为已打开；超时视为未打开。
 * - 请求与 Vault 身份绑定（vaultId + configuredAt）；Vault 切换或功能关闭后，
 *   未决请求一律作废，绝不把旧请求落到新 Vault 上。
 * - 会话停止/删除时取消该会话的所有未决请求。
 */

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  VaultPresentationRequest,
  VaultPresentationResult,
  VaultPresentationTarget,
} from '@proma/shared'

/** 默认等待渲染进程确认的时间；与官方 8s 一致。 */
const DEFAULT_TIMEOUT_MS = 8_000

interface VaultIdentity {
  vaultId: string
  configuredAt: number
}

interface PendingPresentation {
  request: VaultPresentationRequest
  sender: WebContents
  finish(result: VaultPresentationResult, cancel?: boolean): void
}

export interface VaultPresentationDeps {
  /** 目标主窗口；不可用时返回 undefined。 */
  getWindow(): { webContents: WebContents; isDestroyed(): boolean } | undefined
  /** Vault 功能是否开启（productivityTools.obsidianEnabled）。 */
  isEnabled(): boolean
  /** 当前配置的 Vault 身份；未配置返回 null。 */
  getIdentity(): VaultIdentity | null
  /** 校验并归一化目标；失败时抛错。 */
  validateTarget(identity: VaultIdentity, target: VaultPresentationTarget): Promise<VaultPresentationTarget>
  /** 向渲染进程发送请求/取消事件。 */
  send(channel: 'request' | 'cancel', payload: unknown): void
  timeoutMs?: number
}

function isVaultPresentationTarget(value: unknown): value is VaultPresentationTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  if (target.kind !== 'file' && target.kind !== 'folder') return false
  return typeof target.relativePath === 'string'
}

export function createVaultPresentationService(deps: VaultPresentationDeps) {
  const pending = new Map<string, PendingPresentation>()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  function isCurrent(identity: VaultIdentity): boolean {
    const current = deps.getIdentity()
    return deps.isEnabled()
      && current !== null
      && current.vaultId === identity.vaultId
      && current.configuredAt === identity.configuredAt
  }

  async function present(
    sessionId: string,
    input: { relativePath?: unknown; kind?: unknown } = {},
    signal?: AbortSignal,
  ): Promise<VaultPresentationResult> {
    const requestId = randomUUID()
    const fail = (status: VaultPresentationResult['status'], message: string): VaultPresentationResult =>
      ({ requestId, status, message })

    if (!deps.isEnabled()) return fail('blocked', 'Vault 功能已关闭')
    if (!sessionId) return fail('blocked', '缺少当前会话')
    if (input.kind !== undefined && input.kind !== 'file' && input.kind !== 'folder') {
      return fail('blocked', 'Vault kind 非法')
    }
    if (input.relativePath !== undefined && typeof input.relativePath !== 'string') {
      return fail('blocked', 'Vault 相对路径非法')
    }
    if (input.kind !== undefined && input.relativePath === undefined) {
      return fail('blocked', '指定 kind 时必须提供 relativePath')
    }

    const identity = deps.getIdentity()
    if (!identity) return fail('unavailable', '尚未配置 Vault，请由用户选择；不会自动选择或切换')

    let target: VaultPresentationTarget | undefined
    if (input.relativePath !== undefined) {
      const candidate = {
        kind: (input.kind ?? 'file') as 'file' | 'folder',
        relativePath: input.relativePath,
      }
      try {
        target = await deps.validateTarget(identity, candidate)
        if (!isCurrent(identity)) return fail('blocked', 'Vault 已切换或功能已关闭')
      } catch (error) {
        return fail('blocked', error instanceof Error ? error.message : 'Vault 目标校验失败')
      }
    }

    if (signal?.aborted) return fail('unavailable', '展示请求已取消')

    const window = deps.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return fail('unavailable', '主窗口不可用')
    }

    const request: VaultPresentationRequest = {
      requestId,
      sessionId,
      vaultId: identity.vaultId,
      configuredAt: identity.configuredAt,
      ...(target ? { target } : {}),
    }

    return new Promise<VaultPresentationResult>((resolve) => {
      const finish = (result: VaultPresentationResult, cancel = false): void => {
        if (!pending.delete(requestId)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (cancel) {
          try {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              deps.send('cancel', { requestId, sessionId })
            }
          } catch {
            // 窗口已销毁时取消通知失败不影响结果返回。
          }
        }
        resolve(result)
      }
      const onAbort = (): void => finish(fail('unavailable', '展示请求已取消'), true)
      const timer = setTimeout(
        () => finish(fail('unavailable', 'Vault 展示确认超时，未确认已打开'), true),
        timeoutMs,
      )

      pending.set(requestId, { request, sender: window.webContents, finish })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        deps.send('request', request)
      } catch {
        finish(fail('unavailable', '无法向主窗口发送 Vault 展示请求'), true)
      }
    })
  }

  /**
   * 渲染进程回执。只接受当前主窗口，且请求仍属该窗口；Vault 身份变化时作废并上报 blocked。
   */
  async function complete(senderId: number, value: unknown): Promise<void> {
    const window = deps.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.id !== senderId) {
      throw new Error('仅当前主窗口可以确认 Vault 展示')
    }
    if (!value || typeof value !== 'object') throw new Error('Vault 展示结果非法')
    const result = value as VaultPresentationResult
    const validStatus = result.status === 'opened'
      || result.status === 'queued'
      || result.status === 'blocked'
      || result.status === 'unavailable'
    if (typeof result.requestId !== 'string' || !validStatus) throw new Error('Vault 展示结果非法')
    if (result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 2_000)) {
      throw new Error('Vault 展示结果非法')
    }

    const entry = pending.get(result.requestId)
    if (!entry) return
    if (entry.sender !== window.webContents) throw new Error('Vault 展示请求不属于当前窗口')

    try {
      if (!isCurrent(entry.request)) throw new Error('Vault 已切换或功能已关闭')
      if (entry.request.target) {
        await deps.validateTarget(entry.request, entry.request.target)
      }
      if (!isCurrent(entry.request)) throw new Error('Vault 已切换或功能已关闭')
      if (deps.getWindow()?.webContents !== window.webContents) throw new Error('主窗口已改变')
      entry.finish({ requestId: result.requestId, status: result.status, ...(result.message ? { message: result.message } : {}) })
    } catch (error) {
      entry.finish({ requestId: result.requestId, status: 'blocked', message: error instanceof Error ? error.message : 'Vault 目标已失效' }, true)
    }
  }

  /** 会话停止或删除时取消其所有未决展示请求。 */
  function cancelSession(sessionId: string): void {
    for (const entry of [...pending.values()]) {
      if (entry.request.sessionId !== sessionId) continue
      entry.finish({ requestId: entry.request.requestId, status: 'unavailable', message: '会话已停止或删除，展示请求已取消' }, true)
    }
  }

  /** 测试与诊断用：当前未决请求数。 */
  function pendingCount(): number {
    return pending.size
  }

  return { present, complete, cancelSession, pendingCount, isVaultPresentationTarget }
}

/**
 * 运行时单例注册表。
 *
 * Agent 工具需要拿到当前服务实例，但工具层不应 import 主进程的 ipc.ts（会形成环）。
 * 由 ipc.ts 在注册时调用 setVaultPresentationService 注入，工具层只读。
 */
let activeVaultPresentationService: ReturnType<typeof createVaultPresentationService> | undefined

export function setVaultPresentationService(service: ReturnType<typeof createVaultPresentationService> | undefined): void {
  activeVaultPresentationService = service
}

/** 供 Agent 工具使用；未注册时返回 undefined，工具给出明确提示而不是抛错。 */
export function getVaultPresentationService(): ReturnType<typeof createVaultPresentationService> | undefined {
  return activeVaultPresentationService
}
