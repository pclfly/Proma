/**
 * Cloud 请求基础设施
 *
 * 与官方 0.22.0 `packages/cloud/src/api/cloud-request.ts` 对齐：
 * - 统一错误归类（network/timeout/server/rate_limited/auth/client/unknown）
 * - 安全的中文错误文案（不回显服务端响应体或 token）
 * - 单次尝试超时 + 父级取消链路
 * - 可注入 fetch，便于纯函数测试
 */

import type {
  CloudApiError,
  CloudApiErrorKind,
  CloudFetch,
} from '../types/api.ts'

/** 网络错误码白名单：只记录这些 code，避免把任意错误详情写进日志 */
export const SAFE_CAUSE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** 按错误类型返回安全文案 */
export function getSafeCloudFailureMessage(kind: CloudApiErrorKind): string {
  switch (kind) {
    case 'network':
      return '未能连接 Proma Cloud。常见原因是设备当前未联网，或本地代理拦截了对 proma.cool 的访问。Proma Cloud 无需代理即可连接；如果你需要长期开启代理，请把 proma.cool 设为直连（绕过代理）后重试。'
    case 'timeout':
      return '连接 Proma Cloud 超时。若正在使用代理，请确认 proma.cool 已设为直连后再重试。'
    case 'server':
      return 'Proma Cloud 暂时不可用，请稍后重试'
    case 'rate_limited':
      return '请求过于频繁，请稍后重试'
    case 'auth':
      return '认证已过期，请重新登录'
    case 'client':
      return '请求未能完成，请检查输入后重试'
    default:
      return '请求失败，请稍后重试'
  }
}

/** 创建结构化错误；kind 缺省时按 HTTP 状态推断 */
export function createApiError(
  status: number,
  kind?: CloudApiErrorKind,
  message?: string,
): CloudApiError {
  const resolvedKind: CloudApiErrorKind = kind ?? (
    status === 0
      ? 'network'
      : status === 401
        ? 'auth'
        : status === 408
          ? 'timeout'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'server'
              : status >= 400
                ? 'client'
                : 'unknown'
  )
  return {
    status,
    kind: resolvedKind,
    retryable: ['network', 'timeout', 'server', 'rate_limited'].includes(resolvedKind),
    message: message ?? getSafeCloudFailureMessage(resolvedKind),
  }
}

const CLOUD_API_ERROR_KINDS: readonly CloudApiErrorKind[] = [
  'network',
  'timeout',
  'server',
  'rate_limited',
  'auth',
  'client',
  'unknown',
]

/** 结构化错误守卫 */
export function isApiError(error: unknown): error is CloudApiError {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as Record<string, unknown>
  return (
    typeof candidate.status === 'number'
    && typeof candidate.message === 'string'
    && typeof candidate.kind === 'string'
    && CLOUD_API_ERROR_KINDS.includes(candidate.kind as CloudApiErrorKind)
    && typeof candidate.retryable === 'boolean'
  )
}

/** 父级 signal 已取消时立即抛出取消错误 */
export function assertCloudRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledCloudRequest()
}

/** 用户取消 / 会话切换导致的请求取消 */
export function cancelledCloudRequest(): CloudApiError {
  return createApiError(0, 'unknown', '请求已取消，请重试')
}

/** 服务端返回了无法解析的响应 */
export function invalidCloudResponse(): CloudApiError {
  return createApiError(0, 'unknown', 'Proma Cloud 返回了无效响应，请稍后重试')
}

/** 默认网络执行器：直接使用 globalThis.fetch */
export const withDefaultCloudFetch = async <T>(
  work: (fetchFn: CloudFetch) => Promise<T>,
): Promise<T> => work(globalThis.fetch)

/**
 * 为一段异步工作施加超时，并与父级 signal 联动。
 *
 * 超时抛出 timeout 错误，父级取消抛出 cancelled 错误。
 */
export async function withCloudDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) throw cancelledCloudRequest()

  const controller = new AbortController()
  let rejectAbort: (reason: CloudApiError) => void = () => {}
  let abortError: CloudApiError | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })

  const abort = (error: CloudApiError): void => {
    if (abortError) return
    abortError = error
    rejectAbort(error)
    controller.abort()
  }

  const onParentAbort = (): void => abort(cancelledCloudRequest())
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => abort(createApiError(0, 'timeout')), Math.max(0, timeoutMs))

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        assertCloudRequestActive(controller.signal)
        return work(controller.signal)
      }),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

/** 仅提取白名单内的 cause.code */
export function safeCauseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const cause = 'cause' in error ? (error as { cause?: unknown }).cause : error
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && SAFE_CAUSE_CODES.has(code) ? code : undefined
}

export interface CloudRequestExecutionOptions {
  /** 单次尝试超时（毫秒） */
  timeoutMs: number
  /** 操作名（日志用，如 login / refresh / cloud） */
  operation: string
  /** 尝试序号（从 0 开始） */
  attempt?: number
  /** 允许 304 作为成功返回（模型目录增量同步） */
  allowNotModified?: boolean
  /** 注入的 fetch */
  fetchFn?: CloudFetch
}

/**
 * 执行一次 HTTP 请求并归一化错误。
 *
 * 非 2xx（除 allowNotModified 的 304）统一抛 CloudApiError；
 * JSON 解析失败映射为 invalidCloudResponse()。
 */
export async function withCloudRequest<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  options: CloudRequestExecutionOptions,
): Promise<T> {
  const start = Date.now()
  let phase: 'headers' | 'body' = 'headers'
  let status = 0

  try {
    return await withCloudDeadline(
      async (signal) => {
        const response = await (options.fetchFn ?? globalThis.fetch)(url, { ...init, signal })
        assertCloudRequestActive(signal)
        status = response.status
        if (!response.ok && !(options.allowNotModified && status === 304)) {
          void response.body?.cancel().catch(() => {})
          throw createApiError(status)
        }
        phase = 'body'
        const data = await read(response)
        assertCloudRequestActive(signal)
        return data
      },
      options.timeoutMs,
      init.signal ?? undefined,
    )
  } catch (error) {
    const failure = isApiError(error)
      ? error
      : error instanceof SyntaxError
        ? invalidCloudResponse()
        : error instanceof Error && error.name === 'AbortError'
          ? createApiError(0, 'timeout')
          : createApiError(0)
    console.warn('[Cloud Request] 请求失败', {
      operation: options.operation,
      phase,
      attempt: options.attempt ?? 0,
      elapsedMs: Date.now() - start,
      status: failure.status || status,
      kind: failure.kind,
      causeCode: safeCauseCode(error),
    })
    throw failure
  }
}
