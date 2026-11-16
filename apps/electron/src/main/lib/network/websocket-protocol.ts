/**
 * 模型 WebSocket 协议辅助。
 *
 * 官方 0.22.0：限制单帧/待确认字节、握手头大小，并只允许把 Codex HTTP 端点
 * 转成对应的 ws/wss 目标，禁止内嵌凭据和 hash。
 */

export const MAX_SOCKET_BYTES = 64 * 1024 * 1024

export function socketBytes(data: string | Uint8Array | ArrayBuffer): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  return data instanceof ArrayBuffer ? data.byteLength : data.byteLength
}

export function socketHeaders(options: unknown): Record<string, string> {
  if (!options || typeof options !== 'object' || !('headers' in options)) return {}
  const headers = Object.fromEntries(new Headers((options as { headers?: HeadersInit }).headers))
  if (Buffer.byteLength(JSON.stringify(headers)) > 64 * 1024) {
    throw new Error('WebSocket握手头过大')
  }
  return headers
}

export function codexWebSocketUrl(baseUrl?: string): string {
  const base = (baseUrl?.trim() || 'https://chatgpt.com/backend-api').replace(/\/+$/, '')
  const url = new URL(
    base.endsWith('/codex/responses')
      ? base
      : base.endsWith('/codex')
        ? `${base}/responses`
        : `${base}/codex/responses`,
  )
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error('无效的模型网络目标')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
