/**
 * 网络错误分类 — Proma 产品层与 Pi runtime 共用的基础定义。
 *
 * 官方 0.21.92 将网络错误从自由文本提升为稳定 kind，供重试分类器、
 * 错误提示和传输层共用。这里保持同一套 kind 与安全错误码规则。
 */

export type NetworkFailureKind =
  | 'proxy-unreachable'
  | 'dns'
  | 'tls'
  | 'connect'
  | 'timeout'
  | 'stream-interrupted'
  | 'cancelled'
  | 'unknown'

const NETWORK_FAILURE_MESSAGES: Record<NetworkFailureKind, string> = {
  'proxy-unreachable': '当前系统代理不可达，请检查系统网络；登录状态已保留。',
  dns: '域名解析失败，请检查系统网络。',
  tls: '网络证书验证失败，请检查系统证书或代理。',
  connect: '网络连接失败，请检查系统网络后重试。',
  timeout: '网络操作超时，请稍后重试。',
  'stream-interrupted': '响应传输中断，已收到的内容已保留。',
  cancelled: '请求已取消。',
  unknown: '网络请求未完成，请检查系统网络后重试。',
}

export class NetworkRequestError extends Error {
  readonly kind: NetworkFailureKind
  readonly scope: string
  readonly causeCode?: string

  constructor(kind: NetworkFailureKind, scope = 'unknown', causeCode?: string) {
    super(NETWORK_FAILURE_MESSAGES[kind])
    this.name = 'NetworkRequestError'
    this.kind = kind
    this.scope = scope
    this.causeCode = causeCode
  }
}

function readStringField(value: unknown, field: 'name' | 'code' | 'message'): string | undefined {
  if (!value || typeof value !== 'object' || !(field in value)) return undefined
  const raw = (value as Record<string, unknown>)[field]
  return typeof raw === 'string' ? raw : undefined
}

/** 提取可安全展示的错误码，避免把堆栈或 URL 带给用户。 */
export function safeNetworkErrorCode(error: unknown): string | undefined {
  const code = readStringField(error, 'code') ?? ''
  if (/^(ERR_[A-Z0-9_]+|E[A-Z0-9_]{2,40})$/.test(code)) return code
  const message = readStringField(error, 'message') ?? ''
  return message.match(/\bERR_[A-Z0-9_]{1,80}\b/)?.[0]
}

/** 把底层异常归到稳定的网络失败 kind。 */
export function classifyNetworkError(error: unknown): NetworkFailureKind {
  if (error instanceof NetworkRequestError) return error.kind
  const name = readStringField(error, 'name')
  if (name === 'AbortError') return 'cancelled'
  if (name === 'TimeoutError') return 'timeout'

  const code = safeNetworkErrorCode(error) ?? ''
  if (/PROXY|TUNNEL/.test(code)) return 'proxy-unreachable'
  if (/NAME_NOT_RESOLVED|DNS_|ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns'
  if (/CERT_|SSL_|TLS_/.test(code)) return 'tls'
  if (/TIMED_OUT|ETIMEDOUT/.test(code)) return 'timeout'
  if (/CONNECTION_RESET|ECONNRESET|INCOMPLETE_CHUNKED/.test(code)) return 'stream-interrupted'
  if (/CONNECTION_|ECONNREFUSED|NETWORK_CHANGED|INTERNET_DISCONNECTED/.test(code)) return 'connect'

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/connect(?:ion)? error|failed to fetch|fetch failed|network error/i.test(message)) return 'connect'
  return 'unknown'
}

/** 通过 Proma 已本地化的错误文案反查 kind；用于跨进程传递后只剩 message 的场景。 */
export function networkFailureKindFromMessage(text: string): NetworkFailureKind | undefined {
  for (const [kind, message] of Object.entries(NETWORK_FAILURE_MESSAGES) as Array<[NetworkFailureKind, string]>) {
    if (text.includes(message)) return kind
  }
  return undefined
}
