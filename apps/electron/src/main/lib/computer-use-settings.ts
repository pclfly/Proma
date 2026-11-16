/**
 * Computer Use 设置项的纯校验函数。
 *
 * 与 Electron settings 解耦，便于测试；写盘由 computer-use-service 负责。
 */

import { basename, isAbsolute, normalize } from 'node:path'
import type { ComputerUseControlAuthorization } from '@proma/shared'

/** 只接受绝对路径且 basename 必须是 cua-driver(.exe)。 */
export function normalizeComputerUseDriverPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^["']|["']$/g, '')
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return undefined
  if (!isAbsolute(trimmed)) return undefined
  const expected = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  if (basename(trimmed).toLowerCase() !== expected) return undefined
  return normalize(trimmed)
}

export function normalizeComputerUseAuthorization(
  value: unknown,
): ComputerUseControlAuthorization | undefined {
  return value === 'unrequested' || value === 'granted' || value === 'denied'
    ? value
    : undefined
}
