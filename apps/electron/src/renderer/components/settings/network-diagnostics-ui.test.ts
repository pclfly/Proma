import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NetworkDiagnosticReport } from '@proma/shared'
import {
  describeDiagnosticRecord,
  describeNetworkStatus,
  formatDiagnosticDuration,
  summarizeNetworkDiagnostics,
} from './network-diagnostics-ui'

const report: NetworkDiagnosticReport = {
  id: 'report-1',
  schemaVersion: 1,
  generatedAt: '2026-11-10T00:00:00.000Z',
  clientVersion: '0.22.0',
  platform: 'win32',
  network: { policy: 'system', networkEpoch: 2, status: 'ready' },
  records: [
    {
      requestId: 'r1', targetId: 'abc', scope: 'model', phase: 'headers', transport: 'chromium-http',
      epoch: 2, durationMs: 12, outcome: 'response', status: 200,
    },
    {
      requestId: 'r2', targetId: 'def', scope: 'mcp', phase: 'stream', transport: 'chromium-http',
      epoch: 2, durationMs: 3000, outcome: 'failed', failure: 'timeout', errorCode: 'ERR_TIMED_OUT',
    },
    {
      requestId: 'r3', targetId: 'ghi', scope: 'cloud', phase: 'headers', transport: 'chromium-http',
      epoch: 2, durationMs: 50, outcome: 'failed', failure: 'dns',
    },
    {
      requestId: 'r4', targetId: 'jkl', scope: 'oauth', phase: 'headers', transport: 'chromium-http',
      epoch: 2, durationMs: 80, outcome: 'failed', failure: 'dns',
    },
  ],
}

describe('网络诊断设置页展示逻辑', () => {
  test('Given 状态 When 展示 Then 返回中文状态', () => {
    expect(describeNetworkStatus('ready')).toBe('网络就绪')
    expect(describeNetworkStatus('recovering')).toBe('正在恢复网络')
    expect(describeNetworkStatus('unreachable')).toBe('网络不可达')
  })

  test('Given 记录 When 汇总 Then 统计成功/失败并排序失败类型', () => {
    expect(summarizeNetworkDiagnostics(report)).toEqual({
      total: 4,
      succeeded: 1,
      failed: 3,
      failures: [
        { kind: 'dns', count: 2 },
        { kind: 'timeout', count: 1 },
      ],
    })
    expect(summarizeNetworkDiagnostics(null)).toEqual({ total: 0, succeeded: 0, failed: 0, failures: [] })
  })

  test('Given 记录 When 描述 Then 成功显示 HTTP，失败显示中文原因', () => {
    expect(describeDiagnosticRecord(report.records[0]!)).toBe('HTTP 200')
    expect(describeDiagnosticRecord(report.records[1]!)).toBe('超时')
  })

  test('Given 时长 When 格式化 Then 毫秒与秒切换', () => {
    expect(formatDiagnosticDuration(12)).toBe('12 ms')
    expect(formatDiagnosticDuration(1200)).toBe('1.2 s')
    expect(formatDiagnosticDuration(-1)).toBe('—')
  })

  test('Given 设置页 When 接线 Then 消费预览/检查/导出与状态订阅', () => {
    const root = join(import.meta.dir)
    const component = readFileSync(join(root, 'NetworkDiagnosticsSettings.tsx'), 'utf8')
    expect(component).toContain('previewNetworkDiagnostics()')
    expect(component).toContain('checkNetworkDiagnostics()')
    expect(component).toContain('exportNetworkDiagnostics(report.id)')
    expect(component).toContain('onNetworkStatusChanged')
    const panel = readFileSync(join(root, 'SettingsPanel.tsx'), 'utf8')
    expect(panel).toContain('<NetworkDiagnosticsSettings />')
    expect(panel).toContain('label: "网络诊断"')
  })
})
