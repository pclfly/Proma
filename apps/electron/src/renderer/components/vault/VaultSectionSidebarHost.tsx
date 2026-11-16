/**
 * Obsidian 分区侧栏挂载点。
 *
 * VaultView 仍持有 Vault 配置与文件树状态，通过 portal 把内部侧栏投射到这里，
 * 避免把整套目录控制器、弹窗和删除流程提升到 AppShell。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { vaultSectionSidebarSlotAtom } from '@/atoms/vault-atoms'

export function VaultSectionSidebarHost(): React.ReactElement {
  const setSlot = useSetAtom(vaultSectionSidebarSlotAtom)
  const setNode = React.useCallback((node: HTMLDivElement | null) => {
    setSlot(node)
  }, [setSlot])

  return <div ref={setNode} className="h-full min-h-0" />
}
