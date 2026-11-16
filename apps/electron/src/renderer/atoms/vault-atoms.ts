import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { VaultReadResult } from '@proma/shared'

/** A renderer can host several Agent sessions, each with independent Vault navigation. */
export function getVaultSessionScope(sessionId?: string): string {
  return sessionId ?? '__standalone_vault__'
}

export const selectedVaultFileAtomFamily = atomFamily((sessionScope: string) => atom<string | null>(null))
/** Transient navigation target for an Obsidian context chip; not Agent state. */
export const focusedVaultFolderAtomFamily = atomFamily((sessionScope: string) => atom<string | null>(null))
export const vaultReadResultAtomFamily = atomFamily((sessionScope: string) => atom<VaultReadResult | null>(null))
export const vaultRefreshTokenAtom = atom(0)

/**
 * 官方 0.22.0：Obsidian 的 Vault 选择器与文件树挂在全局分区侧栏。
 * VaultView 通过 portal 把内部 sideb 投射到该挂载点，避免复制其复杂状态。
 */
export const vaultSectionSidebarSlotAtom = atom<HTMLElement | null>(null)
