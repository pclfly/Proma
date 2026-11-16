/**
 * Proma Cloud 模式与 API 配置
 *
 * 纯配置模块：不读取文件、不访问登录态、不发起网络请求。
 * 具体登录流程与 token 持久化属于主进程 cloud-auth-service 的职责（本轮 deferred）。
 */

/** Cloud 客户端默认配置（与官方 0.22.0 保持一致） */
export interface CloudApiConfig {
  /** Proma Cloud API 根地址（含版本前缀） */
  baseUrl: string
  /** 单次请求超时（毫秒） */
  timeout: number
}

/** 官方 0.22.0 使用的默认 API 根地址 */
export const PRODUCTION_CLOUD_API_BASE_URL = 'https://api.proma.cool/api/v1'

/** 默认超时：30 秒 */
export const DEFAULT_CLOUD_API_TIMEOUT_MS = 30_000

/** 默认配置（冻结，避免调用方误改共享对象） */
export const DEFAULT_CLOUD_API_CONFIG: Readonly<CloudApiConfig> = Object.freeze({
  baseUrl: PRODUCTION_CLOUD_API_BASE_URL,
  timeout: DEFAULT_CLOUD_API_TIMEOUT_MS,
})

export interface CloudApiConfigOverrides {
  baseUrl?: string
  timeout?: number
}

/**
 * 归一化 API 根地址：去掉首尾空白与末尾斜杠。
 *
 * 与官方 client 的 `${config.baseUrl}${path}` 拼接方式兼容；空字符串回退到默认地址。
 */
export function normalizeCloudBaseUrl(baseUrl: string | undefined | null): string {
  const trimmed = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  return trimmed || PRODUCTION_CLOUD_API_BASE_URL
}

/** 解析超时；非法值回退默认值，向下取整并保证非负。 */
export function normalizeCloudTimeout(timeout: number | undefined | null): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
    return DEFAULT_CLOUD_API_TIMEOUT_MS
  }
  return Math.floor(timeout)
}

/** 获取 Cloud API 配置；调用方可注入覆盖项（测试/自建网关）。 */
export function getCloudApiConfig(overrides: CloudApiConfigOverrides = {}): CloudApiConfig {
  return {
    baseUrl: normalizeCloudBaseUrl(overrides.baseUrl),
    timeout: normalizeCloudTimeout(overrides.timeout),
  }
}

/**
 * 拼接 API 地址。
 *
 * - path 为空时返回根地址；
 * - path 不以 `/` 开头时自动补一个；
 * - 保留 path 中的查询串；
 * - 不解析绝对 URL（调用方只应传入 Cloud 相对路径）。
 */
export function resolveCloudApiUrl(baseUrl: string, path: string): string {
  const root = normalizeCloudBaseUrl(baseUrl)
  const trimmedPath = path.trim()
  if (!trimmedPath) return root
  return `${root}${trimmedPath.startsWith('/') ? '' : '/'}${trimmedPath}`
}
