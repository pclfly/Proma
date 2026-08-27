/**
 * Proma 可配置内置能力开关。
 *
 * 这里只有需要用户配置凭据或显式启用的能力；自动化与协作属于 Pi runtime
 * 基础工具，始终按会话上下文注入，不在此处登记或展示。
 */

import { getSettings, updateSettings } from '../settings-service'

const NANO_BANANA_ID = 'nano-banana'

// 本地定制：AI 生图（nano-banana）默认随 Agent 启用，用户仍可在能力列表中手动关闭；
// 其余内置能力按官方模型由 builtinMcpEnabledIds 白名单管理。
export function isBuiltinMcpDefaultDisabled(id: string): boolean {
  // AI 生图默认开启，不在默认禁用列表
  return false
}

export function isBuiltinMcpUserEnabled(id: string): boolean {
  if (id === NANO_BANANA_ID) {
    // 默认开启：仅当用户显式加入黑名单时才关闭
    const disabledIds = getSettings().builtinMcpDisabledIds ?? []
    return !disabledIds.includes(id)
  }
  return (getSettings().builtinMcpEnabledIds ?? []).includes(id)
}

export function setBuiltinMcpUserEnabled(id: string, enabled: boolean): void {
  if (id !== NANO_BANANA_ID) throw new Error(`不支持配置内置能力：${id}`)

  const disabledIds = new Set(getSettings().builtinMcpDisabledIds ?? [])
  if (enabled) disabledIds.delete(id)
  else disabledIds.add(id)
  updateSettings({ builtinMcpDisabledIds: Array.from(disabledIds).sort() })
}
