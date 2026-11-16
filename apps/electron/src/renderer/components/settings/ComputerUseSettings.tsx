/**
 * Computer Use 设置页。
 *
 * 负责 Cua Driver 安装状态、路径覆盖与自动控制授权，并在页面里说明 Proma
 * 自身实际做到了哪一步：Driver 探测 + 授权 + 目标窗口画面镜像（右侧预览）。
 * 真正的点击/输入由 Agent 通过 Cua Driver 命令行执行，不在本页声明为已接入。
 */

import * as React from 'react'
import { AlertCircle, CheckCircle2, Loader2, Monitor, RefreshCw, XCircle } from 'lucide-react'
import type {
  ComputerUseControlAuthorization,
  ComputerUseSettingsState,
} from '@proma/shared'
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from './primitives'
import { Button } from '@/components/ui/button'

const AUTHORIZATION_OPTIONS = [
  { value: 'unrequested', label: '未授权（默认）' },
  { value: 'granted', label: '已授权自动控制' },
  { value: 'denied', label: '已拒绝' },
]

function statusLabel(state: ComputerUseSettingsState): string {
  const installation = state.installation
  if (installation.status === 'installed') return `已安装${installation.version ? ` · ${installation.version}` : ''}`
  if (installation.status === 'not_installed') return '未检测到 Cua Driver'
  if (installation.status === 'needs_attention') return '需要检查 Driver'
  return '当前平台不支持'
}

function StatusIcon({ state }: { state: ComputerUseSettingsState }): React.ReactElement {
  if (state.installation.status === 'installed') return <CheckCircle2 size={16} className="text-emerald-500" />
  if (state.installation.status === 'needs_attention') return <AlertCircle size={16} className="text-amber-500" />
  return <XCircle size={16} className="text-muted-foreground" />
}

export function ComputerUseSettings(): React.ReactElement {
  const [state, setState] = React.useState<ComputerUseSettingsState | null>(null)
  const [driverPath, setDriverPath] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const next = await window.electronAPI.getComputerUseSettings()
      setState(next)
      setDriverPath(next.driverPath ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const saveDriverPath = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const next = await window.electronAPI.setComputerUseDriverPath(driverPath.trim())
      setState(next)
      setDriverPath(next.driverPath ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const changeAuthorization = async (value: string): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const next = await window.electronAPI.setComputerUseAuthorization(value as ComputerUseControlAuthorization)
      setState(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !state) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 size={24} className="animate-spin" />
        <span className="ml-2">正在检测 Cua Driver…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Computer Use"
        description="允许 Agent 观察并操作桌面应用。默认关闭，只有显式授权且安装 Cua Driver 后才可能执行原生控制。"
        action={(
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || saving}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span className="ml-1">重新检测</span>
          </Button>
        )}
      >
        <SettingsCard>
          <div className="flex items-center gap-3 px-4 py-3">
            <Monitor size={18} className="text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{state ? statusLabel(state) : '未知状态'}</div>
              <div className="text-xs text-muted-foreground">
                {state?.installation.driverPath ?? '未解析到 driver 路径'}
              </div>
            </div>
            {state && <StatusIcon state={state} />}
          </div>

          <SettingsInput
            label="Cua Driver 路径"
            description="留空则自动探测默认安装目录与 PATH；填写时必须是 cua-driver(.exe) 的绝对路径。"
            value={driverPath}
            onChange={setDriverPath}
            placeholder="C:\\Users\\...\\cua-driver.exe"
            disabled={saving}
          />
          <div className="flex justify-end px-4 pb-3">
            <Button size="sm" onClick={() => void saveDriverPath()} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              <span className="ml-1">保存路径</span>
            </Button>
          </div>

          <SettingsSelect
            label="自动控制授权"
            description="只有「已授权自动控制」时，Proma 才会调用 Cua Driver 读取目标窗口画面（右侧预览）；未授权时预览会直接提示需要授权。"
            value={state?.authorization ?? 'unrequested'}
            onValueChange={(value) => void changeAuthorization(value)}
            options={AUTHORIZATION_OPTIONS}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <p className="text-foreground/80">Proma 自身已完成：Driver 安装探测、驱动路径与授权设置、目标窗口画面镜像（右侧预览）。</p>
        <p className="mt-1">
          桌面点击与输入由 Agent 通过 Cua Driver 的命令行工具执行，不在 Proma 进程内注入；
          在这里授权只放开 Proma 自己的读取/预览调用，不会让系统立即执行任何桌面操作。
        </p>
        <p className="mt-1">
          Windows 的预览是按需抓帧后刷新；原生实时预览流与 Apple Vision OCR 仅 macOS 且随应用的 Vision helper 提供。
        </p>
      </div>
    </div>
  )
}
