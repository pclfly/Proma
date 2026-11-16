/**
 * 系统网络状态与诊断契约（官方 0.22.0）。
 */

export const NETWORK_IPC_CHANNELS = {
  NOTIFY_ONLINE: 'network:notify-online',
  GET_STATUS: 'network:get-status',
  RECONNECT: 'network:reconnect',
  STATUS_CHANGED: 'network:status-changed',
  DIAGNOSTICS_PREVIEW: 'network:diagnostics-preview',
  DIAGNOSTICS_CHECK: 'network:diagnostics-check',
  DIAGNOSTICS_EXPORT: 'network:diagnostics-export',
} as const

export type NetworkStatus = 'recovering' | 'ready' | 'unreachable'
export type NetworkFailureKind =
  | 'proxy-unreachable'
  | 'dns'
  | 'tls'
  | 'connect'
  | 'timeout'
  | 'stream-interrupted'
  | 'cancelled'
  | 'unknown'

export interface NetworkSnapshot {
  policy: 'system'
  networkEpoch: number
  status: NetworkStatus
}

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
  network: NetworkSnapshot
  records: NetworkDiagnosticRecord[]
  probe?: NetworkDiagnosticProbe
}
