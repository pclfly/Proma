/**
 * 网络诊断。
 *
 * 官方 0.22.0：记录最近 100 条请求结果（目标只保留加盐 HMAC 前缀），
 * 生成最多 5 份可导出预览；主动探测固定走 Proma 公共健康检查。
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  NetworkRequestError,
  classifyNetworkError,
  safeNetworkErrorCode,
  type NetworkFailureKind,
} from './network-errors'
import type { SystemNetworkFetch, SystemNetworkSnapshot } from './system-network-service'

export type NetworkDiagnosticScope = 'cloud' | 'model' | 'mcp' | 'oauth' | 'download'

export interface NetworkDiagnosticRecord {
  requestId: string
  targetId: string
  scope: string
  phase: 'headers' | 'stream'
  transport: string
  epoch: number
  durationMs: number
  outcome: 'response' | 'failed'
  status?: number
  failure?: NetworkFailureKind
  errorCode?: string
}

export interface NetworkDiagnosticProbe {
  target: 'proma-public-health'
  outcome: 'response' | 'failed'
  status?: number
  failure?: NetworkFailureKind
  durationMs: number
}

export interface NetworkDiagnosticReport {
  id: string
  schemaVersion: 1
  generatedAt: string
  clientVersion: string
  platform: string
  network: SystemNetworkSnapshot
  records: NetworkDiagnosticRecord[]
  probe?: NetworkDiagnosticProbe
}

export interface UtilityFailureNotice {
  scope: NetworkDiagnosticScope
  phase: 'headers' | 'stream'
  failure: NetworkFailureKind
  epoch: number
}

export interface NetworkDiagnosticsDependencies {
  fetch: SystemNetworkFetch
  snapshot: () => SystemNetworkSnapshot
  clientVersion: string
  platform: string
  now?: () => number
  timeoutMs?: number
}

export interface NetworkDiagnostics {
  wrapFetch: (transport: SystemNetworkFetch, scope: NetworkDiagnosticScope) => SystemNetworkFetch
  preview: () => NetworkDiagnosticReport
  check: () => Promise<NetworkDiagnosticReport>
  recordUtilityFailure: (notice: UtilityFailureNotice) => void
  reportForExport: (id: string) => NetworkDiagnosticReport | undefined
}

const KNOWN_ERROR_CODES = new Set([
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_TIMED_OUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
])

const MAX_RECORDS = 100
const MAX_PREVIEWS = 5
const PREVIEW_TTL_MS = 300_000
const CHECK_COOLDOWN_MS = 5_000

export function createNetworkDiagnostics(
  dependencies: NetworkDiagnosticsDependencies,
): NetworkDiagnostics {
  const now = dependencies.now ?? Date.now
  const salt = randomBytes(32)
  const records: NetworkDiagnosticRecord[] = []
  const previews = new Map<string, { at: number; report: NetworkDiagnosticReport }>()
  let probe: NetworkDiagnosticProbe | undefined
  let checking: Promise<NetworkDiagnosticReport> | undefined
  let lastCheck = -Infinity

  const elapsed = (start: number): number => Math.max(0, Math.round(now() - start))

  const preview = (): NetworkDiagnosticReport => {
    const report: NetworkDiagnosticReport = {
      id: randomUUID(),
      schemaVersion: 1,
      generatedAt: new Date(now()).toISOString(),
      clientVersion: dependencies.clientVersion,
      platform: dependencies.platform,
      network: dependencies.snapshot(),
      records: structuredClone(records),
      ...(probe ? { probe: { ...probe } } : {}),
    }
    previews.set(report.id, { at: now(), report: structuredClone(report) })
    while (previews.size > MAX_PREVIEWS) {
      const oldest = previews.keys().next().value
      if (oldest === undefined) break
      previews.delete(oldest)
    }
    return report
  }

  const wrapFetch = (
    transport: SystemNetworkFetch,
    scope: NetworkDiagnosticScope,
  ): SystemNetworkFetch => {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = now()
      let targetId = 'invalid-target'
      try {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        )
        targetId = createHmac('sha256', salt).update(url.origin).digest('hex').slice(0, 16)
      } catch {
        // 无效 URL 使用固定占位，不记录原始输入。
      }
      const base = {
        requestId: randomUUID(),
        targetId,
        scope,
        phase: 'headers' as const,
        transport: 'chromium-http',
        epoch: dependencies.snapshot().networkEpoch,
      }
      try {
        const response = await transport(input, init)
        records.push({ ...base, durationMs: elapsed(start), outcome: 'response', status: response.status })
        return response
      } catch (error) {
        const code = safeNetworkErrorCode(error)
        records.push({
          ...base,
          durationMs: elapsed(start),
          outcome: 'failed',
          failure: classifyNetworkError(error),
          ...(code && KNOWN_ERROR_CODES.has(code) ? { errorCode: code } : {}),
        })
        throw error
      } finally {
        if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
      }
    }
  }

  const check = (): Promise<NetworkDiagnosticReport> => {
    if (checking) return checking
    if (now() - lastCheck < CHECK_COOLDOWN_MS) return Promise.resolve(preview())
    lastCheck = now()
    checking = (async () => {
      const start = now()
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            const response = await dependencies.fetch('https://api.proma.cool/api/health', {
              method: 'GET',
              credentials: 'omit',
              redirect: 'error',
              signal: controller.signal,
            })
            await response.body?.cancel()
            controller.signal.throwIfAborted()
            probe = {
              target: 'proma-public-health',
              outcome: 'response',
              status: response.status,
              durationMs: elapsed(start),
            }
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new NetworkRequestError('timeout', 'cloud'))
            }, dependencies.timeoutMs ?? 5_000)
          }),
        ])
      } catch (error) {
        probe = {
          target: 'proma-public-health',
          outcome: 'failed',
          failure: controller.signal.aborted ? 'timeout' : classifyNetworkError(error),
          durationMs: elapsed(start),
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
      return preview()
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  return {
    wrapFetch,
    preview,
    check,
    recordUtilityFailure(notice) {
      records.push({
        requestId: randomUUID(),
        targetId: 'utility-managed',
        scope: notice.scope,
        phase: notice.phase,
        transport: 'utility-chromium-http',
        epoch: notice.epoch,
        durationMs: 0,
        outcome: 'failed',
        failure: notice.failure,
      })
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
    },
    reportForExport(id) {
      const saved = previews.get(id)
      if (!saved || now() - saved.at > PREVIEW_TTL_MS) {
        previews.delete(id)
        return undefined
      }
      return structuredClone(saved.report)
    },
  }
}
