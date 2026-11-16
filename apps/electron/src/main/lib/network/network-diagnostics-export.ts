/**
 * 网络诊断报告导出。
 *
 * 官方 0.22.0：只允许导出最近一次预览生成、5 分钟内有效的报告；
 * 保存对话框同一时间只能有一个，避免并发写同一路径。
 */

import type { NetworkDiagnosticReport } from '@proma/shared'

export interface NetworkDiagnosticExportDependencies {
  reportForExport: (id: string) => NetworkDiagnosticReport | undefined
  chooseFile: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  write: (path: string, report: NetworkDiagnosticReport) => void
}

export type NetworkDiagnosticExporter = (
  id: string,
) => Promise<{ saved: boolean }>

export function createNetworkDiagnosticExporter(
  dependencies: NetworkDiagnosticExportDependencies,
): NetworkDiagnosticExporter {
  let saving = false
  return async (id) => {
    if (typeof id !== 'string' || id.length > 80) {
      throw new Error('诊断预览无效，请重新预览')
    }
    const report = dependencies.reportForExport(id)
    if (!report) throw new Error('诊断预览已过期，请重新预览')
    if (saving) throw new Error('请先完成当前诊断保存操作')
    saving = true
    try {
      const result = await dependencies.chooseFile({
        title: '保存已预览的网络诊断',
        defaultPath: 'proma-network-diagnostics.json',
        filters: [{ name: 'JSON诊断报告', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { saved: false }
      dependencies.write(result.filePath, report)
      return { saved: true }
    } catch {
      throw new Error('无法保存诊断报告，请选择可写目录')
    } finally {
      saving = false
    }
  }
}
