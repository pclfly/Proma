/**
 * Vault 展示请求的渲染进程接收端。
 *
 * 职责边界：
 * - 收到主进程请求后，决定能否立即展示（当前视图是 Agent 且该会话在该工作区可见），
 *   然后回执 opened / queued / blocked / unavailable。
 * - **不**读文件、不产生编辑、不改变用户选择语义：真正加载内容仍由 VaultView 自己的
 *   焦点机制完成。
 * - 主进程侧还会再次校验 Vault 身份，这里只做「能否现在展示」的判定。
 */

import type { VaultPresentationRequest, VaultPresentationResult } from '@proma/shared'

export interface VaultPresentationHostState {
  /** 当前是否处于可展示 Vault 的视图（Agent 且 Vault 组件可见）。 */
  canPresent: boolean
  /** 当前渲染进程正在显示的 Vault 会话作用域。 */
  activeVaultSessionId?: string
}

export interface VaultPresentationHandlerDeps {
  getState(): VaultPresentationHostState
  /** 请求把目标展示到右侧；返回 false 表示未能路由。 */
  present(request: VaultPresentationRequest): boolean
  /** 回执主进程。 */
  ack(result: VaultPresentationResult): Promise<void>
}

/**
 * 处理一个展示请求并回执。
 *
 * - 非用户前台会话（后台/排队）一律 queued，避免抢屏。
 * - 目标无法路由时 blocked，而不是假装打开。
 */
export async function handleVaultPresentationRequest(
  request: VaultPresentationRequest,
  deps: VaultPresentationHandlerDeps,
): Promise<VaultPresentationResult> {
  const { canPresent } = deps.getState()
  if (!canPresent) {
    const result: VaultPresentationResult = {
      requestId: request.requestId,
      status: 'queued',
      message: '当前不在可展示的 Vault 视图，用户返回后会展示',
    }
    await deps.ack(result)
    return result
  }

  const routed = deps.present(request)
  const result: VaultPresentationResult = routed
    ? { requestId: request.requestId, status: 'opened' }
    : { requestId: request.requestId, status: 'blocked', message: '当前无法路由到 Vault 视图' }
  await deps.ack(result)
  return result
}

/** 取消只影响未决请求；已打开的内容不回退，避免把用户正在看的笔记关掉。 */
export function shouldIgnoreVaultPresentationCancel(): boolean {
  return true
}
