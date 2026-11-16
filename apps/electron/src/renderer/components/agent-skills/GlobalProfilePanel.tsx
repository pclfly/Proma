/**
 * 「关于你」全局用户画像面板。
 *
 * 全局 user_profile.md 跨项目共享；项目协作规则仍在「当前项目」Tab。
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react'
import type {
  GlobalProfileHistoryEntry,
  GlobalProfileHistoryVersion,
  GlobalUserProfile,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/components/settings/primitives'
import { cn } from '@/lib/utils'

function profileWarning(profile: GlobalUserProfile | null): string | null {
  if (!profile) return null
  if (profile.pendingCount > 0) return `有 ${profile.pendingCount} 个未完成的旧画像迁移，请先通过 Agent 恢复迁移。`
  if (profile.legacyCount > 0) return `发现 ${profile.legacyCount} 份旧画像，建议通过 Agent 语义合并后再编辑。`
  if (profile.migrationIssues.length > 0) return `有 ${profile.migrationIssues.length} 个画像迁移异常，请检查旧文件。`
  return null
}

/** 资料状态时间：YYYY/M/D HH:mm:ss，与截图中的本地时间格式一致。 */
function formatProfileTime(value?: number): string {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无'
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

export function GlobalProfilePanel(): React.ReactElement {
  const [profile, setProfile] = React.useState<GlobalUserProfile | null>(null)
  const [text, setText] = React.useState('')
  const [baseContent, setBaseContent] = React.useState('')
  const [history, setHistory] = React.useState<GlobalProfileHistoryEntry[]>([])
  const [selectedHistory, setSelectedHistory] = React.useState<GlobalProfileHistoryVersion | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [next, versions] = await Promise.all([
        window.electronAPI.readGlobalProfile(),
        window.electronAPI.readGlobalProfileHistory(8),
      ])
      setProfile(next)
      setText(next.content ?? '')
      setBaseContent(next.content ?? '')
      setHistory(versions)
      setSelectedHistory(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const dirty = text !== baseContent
  const warning = profileWarning(profile)
  const saveDisabled = !profile || !dirty || saving || !text.trim() || Boolean(warning)

  const save = React.useCallback(async (): Promise<void> => {
    if (!profile || saveDisabled) return
    setSaving(true)
    setError('')
    try {
      const next = await window.electronAPI.writeGlobalProfile(profile.revision, text)
      setProfile(next)
      setText(next.content ?? '')
      setBaseContent(next.content ?? '')
      setHistory(await window.electronAPI.readGlobalProfileHistory(8))
      toast.success('已保存，所有项目的后续 Agent 请求将使用这份画像')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败，请重试'
      setError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }, [profile, saveDisabled, text])

  const viewHistory = React.useCallback(async (entry: GlobalProfileHistoryEntry): Promise<void> => {
    try {
      const version = await window.electronAPI.readGlobalProfileHistoryVersion(entry.revision)
      setSelectedHistory({ ...version, savedAt: entry.savedAt } as GlobalProfileHistoryVersion & { savedAt?: number })
    } catch (cause) {
      toast.error('读取历史版本失败', { description: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [])

  const restore = React.useCallback(async (): Promise<void> => {
    if (!profile || !selectedHistory || restoring) return
    setRestoring(true)
    try {
      const next = await window.electronAPI.restoreGlobalProfileHistory(
        selectedHistory.revision,
        profile.revision,
      )
      setProfile(next)
      setText(next.content ?? '')
      setBaseContent(next.content ?? '')
      setSelectedHistory(null)
      setHistory(await window.electronAPI.readGlobalProfileHistory(8))
      toast.success('已恢复该历史版本，原内容仍保留在历史中')
    } catch (cause) {
      toast.error('恢复历史版本失败', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setRestoring(false)
    }
  }, [profile, restoring, selectedHistory])

  if (loading && !profile) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        读取用户画像中…
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto scrollbar-thin">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">用户画像</h2>
            <span className="rounded bg-foreground/[0.045] px-2 py-0.5 text-[11px] text-muted-foreground">全局共享</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">记录你的长期偏好与协作习惯，所有项目共用。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            <span className="ml-1">刷新</span>
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saveDisabled}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            <span className="ml-1">{dirty ? '保存' : '已保存'}</span>
          </Button>
        </div>
      </div>

      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* 截图版式：左侧资料状态与历史版本，右侧画像正文。 */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <SettingsCard divided={false} className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/50 px-4 py-3">
            <h3 className="text-[13px] font-medium">资料状态</h3>
          </div>
          <div className="space-y-4 border-b border-border/50 px-4 py-4">
            <div className="text-xs">
              <div className="text-muted-foreground">最近更新</div>
              <div className="mt-1 text-[13px] font-medium tabular-nums text-foreground">{formatProfileTime(profile?.modifiedAt)}</div>
            </div>
            <div className="text-xs">
              <div className="text-muted-foreground">最近核验</div>
              <div className="mt-1 text-[13px] font-medium tabular-nums text-foreground">{formatProfileTime(profile?.checkedAt)}</div>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground/70">
              全局画像在所有项目中共享。项目专属偏好可在「当前项目」中补充。
            </p>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[13px] font-medium">历史版本</span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || saving}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              刷新
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {history.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">暂无历史版本</div>
            ) : history.map((entry) => (
              <button
                key={entry.revision}
                type="button"
                onClick={() => void viewHistory(entry)}
                title={entry.summary || undefined}
                className={cn(
                  'flex w-full flex-col gap-1 border-t border-border/30 px-4 py-2.5 text-left transition-colors hover:bg-accent/50',
                  selectedHistory?.revision === entry.revision && 'bg-accent/60',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn(
                    'text-[12px] tabular-nums',
                    entry.current ? 'font-medium text-foreground' : 'text-foreground/70',
                  )}>
                    {formatProfileTime(entry.savedAt)}
                  </span>
                  {entry.current && <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">当前</span>}
                </span>
                <span className="text-[11px] text-muted-foreground">{entry.chars} 字符</span>
              </button>
            ))}
          </div>
          {selectedHistory && (
            <div className="border-t border-border/50 p-3">
              <div className="mb-2 line-clamp-3 max-h-20 overflow-hidden whitespace-pre-wrap text-[11px] text-muted-foreground">
                {selectedHistory.content || '（空版本）'}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={restoring || selectedHistory.revision === profile?.revision}
                onClick={() => void restore()}
              >
                {restoring ? <Loader2 className="size-3.5 animate-spin" /> : null}
                <span className={restoring ? 'ml-1' : ''}>恢复此版本</span>
              </Button>
            </div>
          )}
        </SettingsCard>

        <SettingsCard divided={false} className="flex min-h-[420px] min-w-0 flex-col overflow-hidden">
          <div className="flex items-start gap-2 border-b border-border/50 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">画像内容</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={profile?.path}>
                {profile?.path ?? 'memory/user_profile.md'}
              </div>
            </div>
            {dirty && <span className="mt-1 shrink-0 text-[11px] text-amber-600 dark:text-amber-400">未保存</span>}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="在文件夹中显示用户画像"
              disabled={!profile}
              onClick={() => profile && void window.electronAPI.showItemInFolder(profile.path)}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="尚未建立画像。可以写下希望 Agent 记住的偏好，也可以在对话中逐步积累。"
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            <span>仅影响 Agent 的长期协作偏好，不会上传到云端。</span>
            <span className="ml-auto tabular-nums">{text.length} 字符</span>
          </div>
        </SettingsCard>
      </div>
    </div>
  )
}
