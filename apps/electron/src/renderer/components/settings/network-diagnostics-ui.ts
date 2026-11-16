/**
 * 网络诊断设置页的纯展示逻辑。
 */

import type {
  NetworkDiagnosticRecord,
  NetworkDiagnosticReport,
  NetworkFailureKind,
  NetworkStatus,
} from '@proma/shared'

export const NETWORK_FAILURE_LABELS: Record<NetworkFailureKind, string> = {
  'proxy-unreachable': '代理不可达',
  dns: 'DNS 解析失败',
  tls: '证书/TLS 失败',
  connect: '连接失败',
  timeout: '超时',
  'stream-interrupted': '传输中断',
  cancelled: '已取消',
  unknown: '未知错误',
}

export function describeNetworkStatus(status: NetworkStatus): string {
  if (status === 'ready') return '网络就绪'
  if (status === 'recovering') return '正在恢复网络'
  return '网络不可达'
}

export function summarizeNetworkDiagnostics(
  report: NetworkDiagnosticReport | null,
): { total: number; succeeded: number; failed: number; failures: Array<{ kind: NetworkFailureKind; count: number }> } {
  if (!report) return { total: 0, succeeded: 0, failed: 0, failures: [] }
  const counts = new Map<NetworkFailureKind, number>()
  let succeeded = 0
  let failed = 0
  for (const record of report.records) {
    if (record.outcome === 'response') {
      succeeded += 1
      continue
    }
    failed += 1
    if (record.failure) counts.set(record.failure, (counts.get(record.failure) ?? 0) + 1)
  }
  return {
    total: report.records.length,
    succeeded,
    failed,
    failures: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count),
  }
}

export function describeDiagnosticRecord(record: NetworkDiagnosticRecord): string {
  if (record.outcome === 'response') return `HTTP ${record.status ?? '—'}`
  return record.failure ? NETWORK_FAILURE_LABELS[record.failure] : '请求失败'
}

export function formatDiagnosticDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(1)} s`
}
