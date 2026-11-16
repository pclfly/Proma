/**
 * Cloud API 客户端共享类型
 *
 * 只描述协议层对象，不依赖 Electron / Node fs。
 */

export type CloudApiErrorKind =
  | 'network'
  | 'timeout'
  | 'server'
  | 'rate_limited'
  | 'auth'
  | 'client'
  | 'unknown'

/**
 * Cloud 请求错误（结构化，可安全展示给用户）
 *
 * 注意：message 是经过 `getSafeCloudFailureMessage` 归一化的安全文案，
 * 不包含服务端原始响应体、URL 查询或 token。
 */
export interface CloudApiError {
  status: number
  kind: CloudApiErrorKind
  retryable: boolean
  message: string
}

/** 成功响应包装（与官方 client 的返回值一致） */
export interface CloudApiResponse<T> {
  data: T
  status: number
  ok: true
}

/**
 * fetch 函数类型别名（裁剪版）
 *
 * 不直接使用 `typeof fetch`，避免绑定 Bun/Node 的扩展属性（如 preconnect），
 * 同时保持 globalThis.fetch 与测试替身都可赋值。
 */
export type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * 网络执行器
 *
 * 官方 0.22.0 由主进程注入 system fetch；本地骨架默认为 globalThis.fetch。
 */
export type CloudFetchRunner = <T>(work: (fetchFn: CloudFetch) => Promise<T>) => Promise<T>

/** 客户端请求初始化参数（裁剪过的 fetch init） */
export interface CloudRequestInit {
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal
}

/**
 * Token 存储抽象
 *
 * 主进程实现负责安全存储（safeStorage）与会话版本号；
 * 纯客户端只约定读取/写入语义。未登录时 getToken() 返回空。
 */
export interface CloudTokenStorage {
  /** 当前 access token；未登录返回 null / undefined */
  getToken(): string | null | undefined
  /** 当前 refresh token */
  getRefreshToken(): string | null | undefined
  setToken(token: string): void
  setRefreshToken(token: string | null): void
  /** 登出或刷新失败时清空 */
  clearTokens(): void
  /** 会话版本号：登录/登出/切换账号时递增，用于取消过期在途请求 */
  getSessionRevision(): number
}

export interface CloudApiClientOptions {
  tokenStorage?: CloudTokenStorage
  /** 刷新 token 失败（auth 类错误）时回调，供主进程清空登录态 */
  onAuthFailed?: () => void
  /** 服务端返回 402 时回调（额度不足） */
  onQuotaExceeded?: () => void
  /** 单次尝试超时；默认取 getCloudApiConfig().timeout */
  attemptTimeoutMs?: number
  /** 整个操作（含重试/刷新）超时；默认 timeout * 2 + 1s */
  operationTimeoutMs?: number
  /** 重试基础延迟（毫秒），实际会叠加 0~250ms 抖动 */
  retryDelayMs?: number
  /** 自定义网络执行器 */
  withFetch?: CloudFetchRunner
}

export interface CloudApiClient {
  get<T>(path: string, init?: CloudRequestInit): Promise<CloudApiResponse<T>>
  post<T>(path: string, body?: unknown, init?: CloudRequestInit): Promise<CloudApiResponse<T>>
  put<T>(path: string, body?: unknown, init?: CloudRequestInit): Promise<CloudApiResponse<T>>
  patch<T>(path: string, body?: unknown, init?: CloudRequestInit): Promise<CloudApiResponse<T>>
  del<T>(path: string, init?: CloudRequestInit): Promise<CloudApiResponse<T>>
  /** 主动刷新 access token（内部也会在 401 时自动调用） */
  refreshAuthToken(): Promise<string>
}
