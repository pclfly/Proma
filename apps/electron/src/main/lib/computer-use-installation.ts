/**
 * Computer Use 安装状态探测。
 *
 * 官方 0.22.0：解析 driver 路径 → 执行 `cua-driver --version` →
 * 用严格正则校验版本行。这里保留同样的状态机，并把
 * “解析路径/读取版本”做成注入，方便纯函数测试。
 */

import { execFile } from 'node:child_process'
import type {
  ComputerUseInstallationSummary,
  ComputerUsePlatform,
} from '@proma/shared'
import { ComputerUseDriverError, computerUseDriverPath } from './computer-use-driver'

export function resolveComputerUsePlatform(platform: string): ComputerUsePlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'unsupported'
}

/**
 * 校验并归一化 `cua-driver --version` 输出。
 * 只接受 `cua-driver x.y.z...` 且整行不超过 120 字符；否则返回 undefined。
 */
export function normalizeComputerUseDriverVersion(raw: string): string | undefined {
  const version = raw.trim()
  if (version.length === 0 || version.length > 120) return undefined
  return /^cua-driver\s+\d+\.\d+\.\d+[^\r\n]*$/i.test(version) ? version : undefined
}

export interface ComputerUseInstallationDependencies {
  platform: string
  resolvePath: () => string
  readVersion: (driverPath: string) => Promise<string>
}

/**
 * 探测安装状态：
 * - 平台不支持 → unsupported
 * - 解析不到 driver → not_installed
 * - 版本输出异常 / 执行失败 → needs_attention（保留已解析路径）
 * - 版本合法 → installed
 */
export async function detectComputerUseInstallation(
  dependencies: ComputerUseInstallationDependencies,
): Promise<ComputerUseInstallationSummary> {
  const platform = resolveComputerUsePlatform(dependencies.platform)
  if (platform === 'unsupported') return { platform, status: 'unsupported' }

  let driverPath: string
  try {
    driverPath = dependencies.resolvePath()
  } catch (error) {
    if (error instanceof ComputerUseDriverError && error.code === 'driver_not_found') {
      return { platform, status: 'not_installed' }
    }
    throw error
  }

  try {
    const version = normalizeComputerUseDriverVersion(await dependencies.readVersion(driverPath))
    if (!version) return { platform, status: 'needs_attention', driverPath }
    return { platform, status: 'installed', driverPath, version }
  } catch {
    return { platform, status: 'needs_attention', driverPath }
  }
}

export interface ComputerUseInstallationProbe {
  getStatus: () => Promise<ComputerUseInstallationSummary>
}

/** 同一次并发探测共享一个 Promise；结束后清空，下一次重新探测。 */
export function createComputerUseInstallationProbe(
  dependencies: ComputerUseInstallationDependencies,
): ComputerUseInstallationProbe {
  let pending: Promise<ComputerUseInstallationSummary> | undefined
  return {
    getStatus() {
      pending ??= detectComputerUseInstallation(dependencies).finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}

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

const defaultProbe = createComputerUseInstallationProbe({
  platform: process.platform,
  resolvePath: computerUseDriverPath,
  readVersion: readComputerUseDriverVersion,
})

/** 进程级探测入口；deferred：尚未注册 IPC，等设置页接入时调用。 */
export function getComputerUseInstallationStatus(): Promise<ComputerUseInstallationSummary> {
  return defaultProbe.getStatus()
}
