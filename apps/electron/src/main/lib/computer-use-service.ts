/**
 * Computer Use 设置与状态服务。
 *
 * 官方 0.22.0 的 driver 路径来自 `~/.proma/computer-use.md`；本地额外允许用户在设置中
 * 显式覆盖路径。自动控制授权默认 unrequested，只有 granted 才允许调用 driver。
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import type {
  ComputerUseControlAuthorization,
  ComputerUseSettingsState,
} from '@proma/shared'
import {
  assertComputerUseControlAuthorized,
  computerUseDriverPath,
  ComputerUseDriverError,
} from './computer-use-driver'
import { detectComputerUseInstallation } from './computer-use-installation'
import { getSettings, updateSettings } from './settings-service'
import {
  normalizeComputerUseAuthorization,
  normalizeComputerUseDriverPath,
} from './computer-use-settings'

function readComputerUseDriverVersion(driverPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      driverPath,
      ['--version'],
      { timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

export function resolveConfiguredDriverPath(): string {
  const configured = getSettings().computerUseDriverPath
  if (configured) return configured
  return computerUseDriverPath()
}

export function getComputerUseAuthorization(): ComputerUseControlAuthorization {
  return getSettings().computerUseAuthorization ?? 'unrequested'
}

export async function getComputerUseSettingsState(): Promise<ComputerUseSettingsState> {
  const configured = getSettings().computerUseDriverPath
  const installation = await detectComputerUseInstallation({
    platform: process.platform,
    resolvePath: resolveConfiguredDriverPath,
    readVersion: readComputerUseDriverVersion,
  })
  return {
    installation,
    authorization: getComputerUseAuthorization(),
    ...(configured ? { driverPath: configured } : {}),
  }
}

export function setComputerUseDriverPath(value: string): void {
  const normalized = normalizeComputerUseDriverPath(value)
  if (!normalized) throw new Error('请填写 cua-driver(.exe) 的绝对路径。')
  if (!existsSync(normalized) || !statSync(normalized).isFile()) {
    throw new Error(`Cua Driver 不存在或不是普通文件：${normalized}`)
  }
  updateSettings({ computerUseDriverPath: normalized })
}

export function clearComputerUseDriverPath(): void {
  updateSettings({ computerUseDriverPath: undefined })
}

export function setComputerUseAuthorization(value: unknown): void {
  const normalized = normalizeComputerUseAuthorization(value)
  if (!normalized) throw new Error('Computer Use 授权状态无效。')
  updateSettings({ computerUseAuthorization: normalized })
}

/** 原生预览/输入操作前的统一授权闸门。 */
export function assertComputerUseAuthorized(): void {
  assertComputerUseControlAuthorized(getComputerUseAuthorization())
}

/** 未安装/未授权时给出稳定可读错误，而不是让 renderer 猜测。 */
export function describeComputerUseUnavailable(error: unknown): string {
  if (error instanceof ComputerUseDriverError) return error.message
  return error instanceof Error ? error.message : String(error)
}
