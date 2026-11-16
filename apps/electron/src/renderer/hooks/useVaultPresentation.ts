/**
 * 在渲染进程接住 Agent 的 Vault 展示请求。
 *
 * 与 VaultView 的分工：
 * - 本 Hook 只做「路由判定 + 回执」，把目标交给调用方提供的 openFile/openFolder；
 * - 实际读取、草稿保护、焦点上报仍由 VaultView 自己完成，避免形成第二条内容加载路径。
 */

import { useEffect, useRef } from 'react'
import type { VaultPresentationRequest, VaultPresentationResult } from '@proma/shared'
import { handleVaultPresentationRequest, type VaultPresentationHostState } from '../lib/vault-presentation'

export interface UseVaultPresentationOptions {
  /** 当前能否展示（Agent 视图且 Vault 组件已挂载）。 */
  getState(): VaultPresentationHostState
  /** 打开文件；返回 false 表示无法路由。 */
  openFile(relativePath: string): Promise<boolean> | boolean
  /** 打开文件夹；返回 false 表示无法路由。 */
  openFolder(relativePath: string): Promise<boolean> | boolean
  /** 只打开 Vault 标签、不选中任何目标。 */
  openRoot(): Promise<boolean> | boolean
}

/**
 * 订阅主进程的展示请求。
 *
 * 返回的 cleanup 会同时取消 IPC 订阅；进行中的请求由主进程超时机制收尾，
 * 不需要在卸载时手工回执，避免卸载后仍向已销毁窗口发消息。
 */
export function useVaultPresentation(options: UseVaultPresentationOptions): void {
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onVaultPresentationRequested) return undefined

    const unsubscribeRequest = api.onVaultPresentationRequested((request: VaultPresentationRequest) => {
      void (async () => {
        const current = optionsRef.current
        await handleVaultPresentationRequest(request, {
          getState: () => current.getState(),
          present: (target: VaultPresentationRequest) => {
            const route = target.target
            if (!route) {
              // 省略参数时只打开标签页本身。
              void current.openRoot()
              return true
            }
            if (route.kind === 'file') {
              void current.openFile(route.relativePath)
              return true
            }
            void current.openFolder(route.relativePath)
            return true
          },
          ack: (result: VaultPresentationResult) => api.completeVaultPresentation(result),
        })
      })()
    })

    // 取消只影响未决请求；已打开内容不回退，因此这里不需要动作。
    const unsubscribeCancel = api.onVaultPresentationCancelled?.(() => {}) ?? (() => {})

    return () => {
      unsubscribeRequest()
      unsubscribeCancel()
    }
  }, [])
}
