/**
 * 网络诊断设置页。
 *
 * 展示系统网络快照、最近请求记录和健康检查结果；所有请求都由主进程发起，
 * renderer 只消费诊断报告，不直接访问网络。
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  WifiOff,
} from 'lucide-react'
import type { NetworkDiagnosticReport, NetworkSnapshot } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from './primitives'
import {
  describeDiagnosticRecord,
  describeNetworkStatus,
  formatDiagnosticDuration,
  summarizeNetworkDiagnostics,
} from './network-diagnostics-ui'

function statusTone(status: NetworkSnapshot['status']): string {
  if (status === 'ready') return 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400'
  if (status === 'recovering') return 'border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400'
  return 'border-destructive/20 bg-destructive/[0.04] text-destructive'
}

export function NetworkDiagnosticsSettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<NetworkSnapshot | null>(null)
  const [report, setReport] = React.useState<NetworkDiagnosticReport | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [checking, setChecking] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [status, preview] = await Promise.all([
        window.electronAPI.getNetworkStatus(),
        window.electronAPI.previewNetworkDiagnostics(),
      ])
      setSnapshot(status)
      setReport(preview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    return window.electronAPI.onNetworkStatusChanged((next) => {
      setSnapshot(next)
    })
  }, [refresh])

  const check = React.useCallback(async (): Promise<void> => {
    setChecking(true)
    setError('')
    try {
      const next = await window.electronAPI.checkNetworkDiagnostics()
      setReport(next)
      setSnapshot(next.network)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
    }
  }, [])

  const reconnect = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const next = await window.electronAPI.reconnectNetwork()
      setSnapshot(next)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    }
  }, [refresh])

  const exportReport = React.useCallback(async (): Promise<void> => {
    if (!report || exporting) return
    setExporting(true)
    try {
      const result = await window.electronAPI.exportNetworkDiagnostics(report.id)
      if (result.saved) toast.success('网络诊断报告已保存')
      else toast.info('已取消保存')
    } catch (cause) {
      toast.error('保存网络诊断失败', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setExporting(false)
    }
  }, [exporting, report])

  const summary = summarizeNetworkDiagnostics(report)

  return (
    <div className="space-y-6">
      <SettingsSection
        title="网络诊断"
        description="系统代理状态、最近请求结果与 Proma 健康检查。报告只包含脱敏后的目标哈希，不包含 URL、请求头或凭据。"
        action={(
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking || loading}>
              {checking ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
              <span className="ml-1">主动检查</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              <span className="ml-1">刷新</span>
            </Button>
          </div>
        )}
      >
        <SettingsCard>
          <div className={`flex items-center gap-3 border-b border-border/40 px-4 py-3 ${snapshot ? statusTone(snapshot.status) : ''}`}>
            {snapshot?.status === 'ready' ? <CheckCircle2 size={18} /> : snapshot?.status === 'recovering' ? <Activity size={18} /> : <WifiOff size={18} />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{snapshot ? describeNetworkStatus(snapshot.status) : '尚未读取网络状态'}</div>
              <div className="text-xs opacity-80">
                {snapshot ? `策略 ${snapshot.policy} · epoch ${snapshot.networkEpoch}` : '点击刷新重新读取'}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void reconnect()} disabled={loading}>
              <RotateCcw size={14} />
              <span className="ml-1">重建网络</span>
            </Button>
          </div>

          <div className="grid grid-cols-3 divide-x divide-border/40 border-b border-border/40">
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">记录</div>
              <div className="text-lg font-semibold tabular-nums">{summary.total}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">成功</div>
              <div className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{summary.succeeded}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">失败</div>
              <div className="text-lg font-semibold tabular-nums text-destructive">{summary.failed}</div>
            </div>
          </div>

          {summary.failures.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2 text-xs">
              <AlertTriangle size={13} className="text-amber-500" />
              {summary.failures.map((failure) => (
                <span key={failure.kind} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
                  {failure.kind} × {failure.count}
                </span>
              ))}
            </div>
          )}

          {report?.probe && (
            <div className="border-b border-border/40 px-4 py-2 text-xs">
              <span className="text-muted-foreground">健康检查：</span>
              <span className={report.probe.outcome === 'response' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                {report.probe.outcome === 'response' ? `HTTP ${report.probe.status ?? '—'}` : report.probe.failure ?? '失败'}
              </span>
              <span className="ml-2 text-muted-foreground">{formatDiagnosticDuration(report.probe.durationMs)}</span>
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto scrollbar-thin">
            {report && report.records.length > 0 ? (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Scope</th>
                    <th className="px-3 py-2 font-medium">Phase</th>
                    <th className="px-3 py-2 font-medium">结果</th>
                    <th className="px-3 py-2 font-medium">耗时</th>
                    <th className="px-3 py-2 font-medium">目标</th>
                  </tr>
                </thead>
                <tbody>
                  {[...report.records].reverse().map((record) => (
                    <tr key={record.requestId} className="border-t border-border/30">
                      <td className="px-3 py-1.5 font-mono">{record.scope}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{record.phase}</td>
                      <td className={`px-3 py-1.5 ${record.outcome === 'response' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                        {describeDiagnosticRecord(record)}
                        {record.errorCode ? <span className="ml-1 text-muted-foreground">({record.errorCode})</span> : null}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{formatDiagnosticDuration(record.durationMs)}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{record.targetId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {loading ? '正在读取诊断记录…' : '暂无网络请求记录。'}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/40 px-4 py-3">
            <div className="min-w-0 text-[11px] text-muted-foreground">
              {report ? `生成于 ${new Date(report.generatedAt).toLocaleString()} · client ${report.clientVersion}` : '尚未生成报告'}
            </div>
            <Button variant="outline" size="sm" onClick={() => void exportReport()} disabled={!report || exporting}>
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              <span className="ml-1">导出报告</span>
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}
