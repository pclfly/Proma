/**
 * 模型请求失败分类器。
 *
 * 官方 0.21.92 把“是否重试”从零散正则收敛为单一分类器：
 * - 先排除账单/额度类错误（即使同时带 429 也不能重试）；
 * - 再识别 Chromium/Node 网络错误码、HTTP 状态码和流中断文案；
 * - 最后才回落到 Pi 自身的可重试判断。
 *
 * 官方 0.22.80 补齐“网络重试判定”：
 * - 524 与上游网关瞬时失败（TLS/连接/流/超时）按服务故障重试；
 * - 权限、未认证、无效 API key、上下文超限等确定性失败绝不重试；
 * - Gemini 错误体（JSON `error.code` 与 gRPC 状态文本）折算成等价 HTTP 状态。
 *
 * `installPromaRetryClassifier` 在 Pi session 上覆盖 `_isRetryableError`，
 * 让 SDK 的原生 retry 与 Proma 的分类口径一致。
 */

import { networkFailureKindFromMessage } from './network-errors'

export type ModelFailureReasonKind =
  | 'unknown'
  | 'connection'
  | 'stream_interrupted'
  | 'rate_limited'
  | 'service'
  | 'response_malformed'

export type ModelFailureDetail = 'proxy' | 'dns' | 'offline' | 'network-changed' | 'timeout'

export interface ModelFailureClassification {
  retryable: boolean
  reasonKind: ModelFailureReasonKind
  detail?: ModelFailureDetail
  safeCode?: string
}

export interface ModelFailureDescription {
  title: string
  message: string
}

const BILLING_PATTERN =
  /insufficient_quota|payment_required|积分不足|余额不足|out of budget|quota exceeded|usage limit reached|available balance|\bbilling\b|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_(?:usage_limit_exceeded|workplace_individual_usage_limit_exceeded)/i

/** 上游明确拒绝的确定性失败：重试只会复现同一结果，必须先于 524/上游服务失败返回。 */
const DETERMINISTIC_PROVIDER_FAILURE =
  /permission[_ ]denied|unauthenticated|unauthorized|invalid[ _-](?:api[ _-]?)?key|context[_ ](?:length[_ ]exceeded|window[_ ]exceeded)|maximum context length|prompt is too long|input is too long|too many tokens|exceeds? (?:the )?context (?:window|limit)/i

/** 上游网关自身的瞬时故障（TLS/连接/流/超时），按服务故障重试。 */
const UPSTREAM_SERVICE_FAILURE =
  /\b(?:upstream connection error|upstream tls error|unexpected upstream stream error|request timeout)\b/i

const NON_RETRYABLE_CHROMIUM =
  /^ERR_(?:CERT_[A-Z_]+|ABORTED|UNSAFE_PORT|INVALID_URL|BLOCKED_[A-Z_]+|DISALLOWED_URL_SCHEME|PROXY_AUTH_[A-Z_]+|PROXY_CERTIFICATE_INVALID|SSL_CLIENT_AUTH_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT|ACCESS_DENIED|NETWORK_ACCESS_DENIED|TOO_MANY_REDIRECTS|UNSAFE_REDIRECT|HTTP2_INADEQUATE_TRANSPORT_SECURITY|SSL_VERSION_OR_CIPHER_MISMATCH)$/

const STREAM_CHROMIUM =
  /^ERR_(?:INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH|HTTP2_STREAM_ERROR|HTTP2_STREAM_CLOSED|QUIC_PROTOCOL_ERROR|SPDY_PROTOCOL_ERROR)$/

const CONNECTION_CHROMIUM =
  /^ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|ADDRESS_IN_USE|TIMED_OUT|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|SSL_PROTOCOL_ERROR|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_[A-Z_]+|CONNECTION_[A-Z_]+|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_[A-Z_]+|HTTP2_[A-Z_]+|SPDY_[A-Z_]+|QUIC_[A-Z_]+)$/

const NODE_CONNECTION =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/

const STREAM_DRAIN_TIMEOUT = /drain exceeded (?:configured stream drain duration|stream_drain_max_seconds)/i

const MAX_JSON_ERROR_CHARS = 16_384

/** Gemini/@google/genai 的 gRPC 状态文本到等价 HTTP 状态码。 */
const GEMINI_STATUS_HTTP: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
}

interface JsonErrorEnvelope {
  error?: unknown
}

interface JsonErrorDetail {
  code?: unknown
}

/** Google SDK 会把 AIP-193 错误体直接放进 message（`ApiError: {"error":{...}}`）。 */
function statusFromJsonErrorBody(text: string): number | undefined {
  const jsonText = text.trim().replace(/^ApiError:\s*/, '')
  if (!jsonText.startsWith('{') || jsonText.length > MAX_JSON_ERROR_CHARS) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const { error } = payload as JsonErrorEnvelope
  if (!error || typeof error !== 'object') return undefined
  const { code } = error as JsonErrorDetail
  const value =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && /^[45]\d{2}$/.test(code)
        ? Number(code)
        : Number.NaN
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
}

/** 流式错误只带 gRPC 状态：`got status: UNAVAILABLE. {"error":...}`。 */
function statusFromGeminiStatusText(text: string): number | undefined {
  const statusName = text.match(/(?:got status:\s*|"status"\s*:\s*")([A-Za-z_]+)\b/)?.[1]?.toUpperCase()
  return statusName ? GEMINI_STATUS_HTTP[statusName] : undefined
}

/** 只接受 400-599 的显式状态码，避免把 request id / 字节数误判成 429。 */
export function explicitHttpStatus(text: string): number | undefined {
  const jsonStatus = statusFromJsonErrorBody(text)
  if (jsonStatus !== undefined) return jsonStatus
  const patterns = [
    /^\s*(?:[A-Za-z][\w ]{0,40}?(?:error|Error)\s*[:(]?\s*)?\(?(\d{3})\)?(?=[\s:,{]|$)/,
    /\b(?:http|status|statusCode|status code|error code)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:too many requests|internal server error|bad gateway|service unavailable|gateway timeout|unauthorized|forbidden|not found|bad request|payment required)\b/i,
  ]
  for (const pattern of patterns) {
    const value = Number(pattern.exec(text)?.[1])
    if (value >= 400 && value <= 599) return value
  }
  // gRPC 状态文本只作兜底，避免它盖过正文里更明确的数字状态码。
  return statusFromGeminiStatusText(text)
}

function chromiumCode(text: string): string | undefined {
  return text.match(/\bERR_[A-Z0-9_]{2,80}\b/)?.[0]
}

function chromiumDetail(code: string): ModelFailureDetail | undefined {
  if (/PROXY|TUNNEL|SOCKS/.test(code)) return 'proxy'
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION|DNS_/.test(code)) return 'dns'
  if (/INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED/.test(code)) return 'offline'
  if (code === 'ERR_NETWORK_CHANGED' || code === 'ERR_ADDRESS_UNREACHABLE') return 'network-changed'
  if (/TIMED_OUT/.test(code)) return 'timeout'
  return undefined
}

function reasonKindFromText(text: string, status: number | undefined): ModelFailureReasonKind {
  const lower = text.toLowerCase()
  if (status === 429 || /rate.?limit|too many requests|overloaded|resourceexhausted|high demand/.test(lower)) {
    return 'rate_limited'
  }
  if (status !== undefined && status >= 500) return 'service'
  if (
    /stream.*(?:ended|interrupted|closed)|(?:ended|interrupted|closed).*stream|incomplete chunked|terminal (?:event|response)|stream_read_error|ended without|other side closed|premature close/.test(
      lower,
    )
  ) {
    return 'stream_interrupted'
  }
  if (/unexpected (?:token|non-whitespace|end of json)|invalid (?:json|response)|json.*(?:parse|syntax)|is not valid json/.test(lower)) {
    return 'response_malformed'
  }
  if (/service.?unavailable|bad gateway|gateway timeout|server.?error|internal.?error/.test(lower) || UPSTREAM_SERVICE_FAILURE.test(lower)) {
    return 'service'
  }
  if (
    /connect(?:ion)?|network|failed to fetch|fetch failed|socket|econn|etimedout|enotfound|dns|peer closed|timed? ?out|timeout|websocket/.test(
      lower,
    )
  ) {
    return 'connection'
  }
  return 'unknown'
}

export function classifyModelFailure(
  errorMessage: string | undefined,
  piRetryable = false,
): ModelFailureClassification {
  const text = errorMessage ?? ''
  const status = explicitHttpStatus(text)
  const code = chromiumCode(text)
  const safeCode = code ?? (status !== undefined ? `HTTP ${status}` : text.match(NODE_CONNECTION)?.[1])

  if (BILLING_PATTERN.test(text) || DETERMINISTIC_PROVIDER_FAILURE.test(text)) {
    return { retryable: false, reasonKind: 'unknown', safeCode }
  }
  // 证书、代理认证等 Chromium 永久性错误即使夹带 4xx/5xx 文案也不重试。
  if (code && NON_RETRYABLE_CHROMIUM.test(code)) return { retryable: false, reasonKind: 'connection', safeCode }
  if (status !== undefined && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
    return { retryable: false, reasonKind: 'unknown', safeCode }
  }
  // 524 是上游网关等待源站超时，属服务故障而非客户端断网。
  if (status === 524) return { retryable: true, reasonKind: 'service', safeCode }
  if (STREAM_DRAIN_TIMEOUT.test(text)) {
    return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
  }
  if (UPSTREAM_SERVICE_FAILURE.test(text)) {
    return { retryable: true, reasonKind: status === 429 ? 'rate_limited' : 'service', safeCode }
  }

  if (code) {
    if (STREAM_CHROMIUM.test(code)) return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
    if (CONNECTION_CHROMIUM.test(code)) {
      return { retryable: true, reasonKind: 'connection', detail: chromiumDetail(code), safeCode }
    }
  }

  const networkKind = networkFailureKindFromMessage(text)
  if (networkKind) {
    switch (networkKind) {
      case 'proxy-unreachable':
        return { retryable: true, reasonKind: 'connection', detail: 'proxy', safeCode }
      case 'dns':
        return { retryable: true, reasonKind: 'connection', detail: 'dns', safeCode }
      case 'connect':
        return { retryable: true, reasonKind: 'connection', safeCode }
      case 'timeout':
        return { retryable: true, reasonKind: 'connection', detail: 'timeout', safeCode }
      case 'stream-interrupted':
        return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
      default:
        return { retryable: false, reasonKind: 'connection', safeCode }
    }
  }

  const nodeCode = text.match(NODE_CONNECTION)?.[1]
  if (nodeCode) {
    const detail =
      nodeCode === 'ENOTFOUND' || nodeCode === 'EAI_AGAIN'
        ? 'dns'
        : nodeCode === 'ETIMEDOUT'
          ? 'timeout'
          : undefined
    return { retryable: true, reasonKind: 'connection', detail, safeCode }
  }

  return { retryable: piRetryable, reasonKind: reasonKindFromText(text, status), safeCode }
}

/** 网络/流中断类失败才允许走连接级重试；HTTP 限流与服务错误交给上层策略。 */
export function isRetryableNetworkFailure(errorMessage: string | undefined): boolean {
  const failure = classifyModelFailure(errorMessage)
  return failure.retryable
    && (failure.reasonKind === 'connection' || failure.reasonKind === 'stream_interrupted')
}

/** 把分类结果转成用户可读标题；safeCode 只追加在正文，不进入标题。 */
export function describeModelFailure(classification: ModelFailureClassification): ModelFailureDescription {
  const copy = ((): ModelFailureDescription => {
    if (classification.reasonKind === 'connection') {
      switch (classification.detail) {
        case 'proxy':
          return {
            title: '代理不可用',
            message: '无法连接到系统代理，代理软件可能已退出或正在切换。请确认代理软件正常运行，或在系统设置中关闭代理后重试。',
          }
        case 'dns':
          return {
            title: '域名解析失败',
            message: '无法解析模型服务地址。请检查网络或代理设置后重试。',
          }
        case 'offline':
          return {
            title: '网络已断开',
            message: '设备当前处于离线状态。恢复网络后重试即可。',
          }
        case 'network-changed':
          return {
            title: '网络已切换',
            message: '请求过程中网络发生了切换（例如开关 VPN 或代理），自动重连未能恢复。请确认网络稳定后重试。',
          }
        case 'timeout':
          return {
            title: '网络连接超时',
            message: '连接模型服务超时，自动重连未能恢复。请检查网络或代理线路后重试。',
          }
        default:
          return {
            title: '网络连接中断',
            message: '与模型服务的连接中断，自动重连未能恢复。请检查网络或代理设置后重试。',
          }
      }
    }
    if (classification.reasonKind === 'stream_interrupted') {
      return {
        title: '响应传输中断',
        message: '模型回复在传输过程中断开，自动恢复未能完成。已完成的步骤已保留，请检查网络后重试。',
      }
    }
    if (classification.reasonKind === 'rate_limited') {
      return {
        title: '模型服务繁忙',
        message: '模型服务持续繁忙，自动重试未能恢复。请稍后重试。',
      }
    }
    if (classification.reasonKind === 'service') {
      return {
        title: '模型服务暂时不可用',
        message: '模型服务持续返回异常，自动重试未能恢复。请稍后重试，或切换其他模型。',
      }
    }
    if (classification.reasonKind === 'response_malformed') {
      return {
        title: '响应解析失败',
        message: '上游返回了无法解析的响应，通常为网关瞬时异常，请重试。',
      }
    }
    return { title: '请求未完成', message: '模型请求未能完成，请稍后重试。' }
  })()

  return classification.safeCode
    ? { ...copy, message: `${copy.message}\n错误代码：${classification.safeCode}` }
    : copy
}
