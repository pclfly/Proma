/**
 * Cua Driver 定位、错误归一化与调用封装。
 *
 * 官方 0.22.0 的 driver 模块负责：
 * - 从 `~/.proma/computer-use.md` 记录、平台默认安装目录、PATH 三级解析 driver；
 * - 把 driver 的 stdout JSON 与进程错误统一归类成少量错误码；
 * - 通过 `cua-driver call <tool> <json>` 调用具体工具。
 *
 * 本地批次只启用可测试的部分：路径解析、响应校验、错误分类与 resolver。
 * 真正的 `call` 路径需要用户显式授权（ComputerUseControlAuthorization），
 * 且当前没有注册任何 IPC / 工具，属于 deferred 接入点。
 */

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type {
  ComputerUseControlAuthorization,
  ComputerUseDriverErrorCode,
} from '@proma/shared'

export const COMPUTER_USE_DRIVER_MESSAGES: Record<ComputerUseDriverErrorCode, string> = {
  driver_not_found: '找不到 Cua Driver，请在 Computer Use 设置中确认已安装路径。',
  window_unavailable: '目标窗口已关闭、重建或不再属于原应用，请让 Agent 重新查找窗口。',
  desktop_unavailable: '桌面当前不可用，请解锁电脑并确认 Driver 运行在当前登录的桌面会话中。',
  permission_denied: '系统拒绝访问目标应用，请检查系统授权以及 Driver 与目标应用的权限级别。',
  authorization_required: '需要先在「设置 → Computer Use」中把自动控制授权设为「已授权自动控制」，Proma 才能读取并预览目标画面。',
  timeout: '获取窗口响应超时，请稍后重试。',
  activation_blocked: '系统未允许切换到目标窗口，请手动打开该 App 后再试。',
  capture_failed: '未能取得有效窗口画面，请恢复目标窗口后重试。',
  driver_error: 'Cua Driver 调用失败，请检查当前连接或工具版本后重试。',
}

export class ComputerUseDriverError extends Error {
  readonly code: ComputerUseDriverErrorCode

  constructor(code: ComputerUseDriverErrorCode) {
    super(COMPUTER_USE_DRIVER_MESSAGES[code])
    this.name = 'ComputerUseDriverError'
    this.code = code
  }
}

/** 未获得用户显式授权时拒绝自动控制；与驱动错误区分，便于调用方提示。 */
export class ComputerUseAuthorizationError extends Error {
  readonly authorization: ComputerUseControlAuthorization

  constructor(authorization: ComputerUseControlAuthorization) {
    super('未获得用户对 Computer Use 自动控制的显式授权，已拒绝调用 Cua Driver。')
    this.name = 'ComputerUseAuthorizationError'
    this.authorization = authorization
  }
}

export function assertComputerUseControlAuthorized(
  authorization: ComputerUseControlAuthorization,
): void {
  if (authorization !== 'granted') throw new ComputerUseAuthorizationError(authorization)
}

/**
 * 解析 `computer-use.md` 中记录的绝对路径。
 *
 * 只接受 basename 为 `cua-driver(.exe)` 的绝对路径；同时存在多条时，
 * `driver_path` 显式字段优先，多个候选无法唯一确定则返回 undefined。
 */
export function parseComputerUseDriverPath(
  record: string,
  platform: string,
): string | undefined {
  const paths = platform === 'win32' ? win32 : posix
  const name = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const values: string[] = []
  const explicitValues: string[] = []
  const pattern =
    /^\s*(?:[-*]\s*)?(driver_path|(?:Driver\s*)?绝对路径|Driver\s*路径)\s*[:：]\s*(.+?)\s*$/gim

  for (const match of record.matchAll(pattern)) {
    let value = (match[2] ?? '').trim()
    if (!value) continue
    if (/^([`'"]).*\1$/.test(value)) value = value.slice(1, -1)
    const absolute = platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : paths.isAbsolute(value)
    if (!absolute || /[\r\n\0]/.test(value)) continue
    if (paths.basename(value).toLowerCase() !== name) continue
    const field = (match[1] ?? '').toLowerCase()
    const target = field === 'driver_path' ? explicitValues : values
    target.push(paths.normalize(value))
  }

  const unique = [...new Set(explicitValues.length > 0 ? explicitValues : values)]
  return unique.length === 1 ? unique[0] : undefined
}

/**
 * 按官方顺序把 driver 细节归类：窗口失效 → 桌面不可用 → 激活失败 →
 * 权限拒绝 → 超时 → 采集失败 → 兜底 driver_error。
 */
export function classifyComputerUseDriverError(detail: string): ComputerUseDriverError {
  const text = detail.toLowerCase()
  const code: ComputerUseDriverErrorCode =
    /window_id_not_found|window_owner_pid_mismatch|invalid window|stale.*hwnd|0x80070578/.test(text)
      ? 'window_unavailable'
      : /screen_locked|session.?0|interactive.*(?:session|desktop)|desktop.*unavailable|disconnected.*session/.test(text)
        ? 'desktop_unavailable'
        : /landed_on_target.*false|foreground.*(?:reject|denied)|activation.*blocked/.test(text)
          ? 'activation_blocked'
          : /access.denied|permission.denied|eacces|eperm|uipi|0x80070005/.test(text)
            ? 'permission_denied'
            : /timed?.?out|timeout/.test(text)
              ? 'timeout'
              : /px_frame_mismatch|px_capture_unavailable|capture.failed|screenshot.*(?:fail|unavailable)/.test(text)
                ? 'capture_failed'
                : 'driver_error'
  return new ComputerUseDriverError(code)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 校验 driver 的 stdout JSON。
 *
 * 非 JSON / 非对象视为“无结构化状态”，不在这里报错（调用方仍可使用 stdout）；
 * 一旦出现 isError / success:false / error / landed_on_target:false，
 * 统一抛出分类后的 ComputerUseDriverError。
 */
export function checkComputerUseDriverResponse(stdout: string): void {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return
  }
  const response = asRecord(value)
  if (!response) return
  const structured = asRecord(response.structuredContent)
  const failed =
    response.isError === true ||
    response.success === false ||
    Boolean(response.error) ||
    structured?.isError === true ||
    structured?.success === false ||
    Boolean(structured?.error) ||
    response.landed_on_target === false ||
    structured?.landed_on_target === false
  if (failed) throw classifyComputerUseDriverError(stdout)
}

export interface ComputerUseDriverEnvironment {
  platform: string
  home: string
  localAppData?: string
  path: string
  recordVersion: (path: string) => string
  readRecord: (path: string) => string
  isFile: (path: string) => boolean
}

interface CachedDriver {
  path: string
  recordVersion: string
}

/**
 * driver 路径解析器。
 *
 * 解析顺序：记录文件 → 平台默认安装目录 → PATH；记录文件变化（mtime/ctime/size）
 * 会让缓存失效。文件系统访问全部通过注入的 environment，便于纯函数测试。
 */
export class ComputerUseDriverResolver {
  private cached: CachedDriver | undefined

  constructor(private readonly environment: ComputerUseDriverEnvironment) {}

  invalidate(): void {
    this.cached = undefined
  }

  resolve(): string {
    const env = this.environment
    const paths = env.platform === 'win32' ? win32 : posix
    const recordPath = paths.join(env.home, '.proma', 'computer-use.md')
    const recordVersion = env.recordVersion(recordPath)
    if (this.cached?.recordVersion === recordVersion && env.isFile(this.cached.path)) {
      return this.cached.path
    }

    const recorded = parseComputerUseDriverPath(env.readRecord(recordPath), env.platform)
    const name = env.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
    const localAppData = env.localAppData || paths.join(env.home, 'AppData', 'Local')
    const defaults =
      env.platform === 'win32'
        ? [
            paths.join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', name),
            paths.join(localAppData, 'Programs', 'trycua', 'cua-driver-rs', 'bin', name),
          ]
        : [
            paths.join(env.home, '.local', 'bin', name),
            ...(env.platform === 'darwin'
              ? ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver']
              : []),
          ]
    const fromPath = env.path
      .split(paths.delimiter)
      .map((dir) => dir.replace(/^"|"$/g, ''))
      .filter((dir) => (env.platform === 'win32' ? /^[a-z]:[\\/]/i.test(dir) : paths.isAbsolute(dir)))
      .map((dir) => paths.join(dir, name))
    const candidates = [recorded, ...defaults, ...fromPath]
    const found = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && env.isFile(candidate),
    )

    if (!found) {
      this.invalidate()
      throw new ComputerUseDriverError('driver_not_found')
    }
    this.cached = { path: found, recordVersion }
    return found
  }
}

export function createComputerUseDriverEnvironment(): ComputerUseDriverEnvironment {
  return {
    platform: process.platform,
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    path: process.env.PATH || '',
    recordVersion: (path) => {
      try {
        const stats = statSync(path)
        return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
      } catch {
        return ''
      }
    },
    readRecord: (path) => {
      try {
        return statSync(path).size <= 64 * 1024 ? readFileSync(path, 'utf8') : ''
      } catch {
        return ''
      }
    },
    isFile: (path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
  }
}

const defaultResolver = new ComputerUseDriverResolver(createComputerUseDriverEnvironment())

/** 进程级 singleton；调用时才访问文件系统。 */
export function computerUseDriverPath(): string {
  return defaultResolver.resolve()
}

export interface ComputerUseDriverRunOptions {
  timeout: number
  maxBuffer: number
  signal?: AbortSignal
}

export interface ComputerUseDriverRunResult {
  stdout: string
  stderr: string
}

export type ComputerUseDriverInvoke = (
  file: string,
  args: string[],
  options: ComputerUseDriverRunOptions,
) => Promise<ComputerUseDriverRunResult>

export interface ComputerUseDriverClientOptions {
  resolvePath: () => string
  invoke: ComputerUseDriverInvoke
  /** 默认 unrequested：未显式授权时 call 直接拒绝。 */
  authorization: ComputerUseControlAuthorization
  invalidate?: () => void
}

export interface ComputerUseDriverClient {
  call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>
}

/**
 * 构造 driver 调用器（接口保留，当前未接入任何 IPC/工具）。
 *
 * 与官方一致：ENOENT 时 invalidate 并重试一次；超时（killed）归一为 timeout；
 * 其余错误按 stdout/stderr 细节分类。`authorization` 是本地的安全闸门。
 */
export function createComputerUseDriverClient(
  options: ComputerUseDriverClientOptions,
): ComputerUseDriverClient {
  const invalidate = options.invalidate ?? (() => {})
  return {
    async call(tool, args, signal) {
      assertComputerUseControlAuthorized(options.authorization)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('操作已取消')
        }
        try {
          const result = await options.invoke(
            options.resolvePath(),
            ['call', tool, JSON.stringify(args)],
            {
              timeout: 8_000,
              maxBuffer: 2 * 1024 * 1024,
              ...(signal ? { signal } : {}),
            },
          )
          checkComputerUseDriverResponse(result.stdout)
          return result.stdout
        } catch (error) {
          if (signal?.aborted || error instanceof ComputerUseDriverError) throw error
          const failure = error as {
            code?: unknown
            killed?: unknown
            driverDetail?: unknown
            message?: unknown
          }
          const code = typeof failure.code === 'string' ? failure.code : ''
          if (code === 'ENOENT') {
            invalidate()
            if (attempt === 0) continue
            throw new ComputerUseDriverError('driver_not_found')
          }
          if (failure.killed === true) throw new ComputerUseDriverError('timeout')
          const detail =
            typeof failure.driverDetail === 'string'
              ? failure.driverDetail
              : typeof failure.message === 'string'
                ? failure.message
                : String(error)
          throw classifyComputerUseDriverError(`${code} ${detail}`)
        }
      }
      throw new ComputerUseDriverError('driver_not_found')
    },
  }
}

/** 默认进程执行器；deferred：只在显式构造 client 且授权为 granted 时可达。 */
export const nodeComputerUseDriverInvoke: ComputerUseDriverInvoke = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { driverDetail: `${stdout}\n${stderr}` }))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
