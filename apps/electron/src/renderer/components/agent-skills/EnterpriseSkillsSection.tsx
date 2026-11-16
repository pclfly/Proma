/**
 * 企业 Skills 库区块。
 *
 * 消费主进程的三类接口：列表（含可用性）、安装到当前工作区、已安装项更新检查。
 * 企业库未接入时只展示原因，不伪造空列表成功。
 */

import * as React from 'react'
import { Building2, Check, Download, Loader2, RefreshCw, Store } from 'lucide-react'
import { toast } from 'sonner'
import type {
  EnterpriseSkillLibraryItem,
  EnterpriseSkillUpdateEntry,
  EnterpriseSkillsListResult,
  SkillMeta,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  buildEnterpriseSkillRows,
  countInstalledEnterpriseSkills,
  describeEnterpriseSkillsAvailability,
} from './enterprise-skills-ui'

interface EnterpriseSkillsSectionProps {
  workspaceSlug: string
  installedSkills: SkillMeta[]
  onChanged: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '企业 Skills 服务暂时不可用'
}

export function EnterpriseSkillsSection({
  workspaceSlug,
  installedSkills,
  onChanged,
}: EnterpriseSkillsSectionProps): React.ReactElement | null {
  const [library, setLibrary] = React.useState<EnterpriseSkillsListResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [installingId, setInstallingId] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [updates, setUpdates] = React.useState<EnterpriseSkillUpdateEntry[]>([])
  const [lastCheckedAt, setLastCheckedAt] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!workspaceSlug) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const api = window.electronAPI as Partial<typeof window.electronAPI>
    if (typeof api.listEnterpriseSkills !== 'function') {
      setError('当前版本未提供企业 Skills 接口')
      setLoading(false)
      return
    }
    void api.listEnterpriseSkills()
      .then((result) => {
        if (cancelled) return
        setLibrary(result)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [refreshToken, workspaceSlug])

  const rows = React.useMemo(
    () => buildEnterpriseSkillRows(library?.items ?? [], installedSkills, updates),
    [installedSkills, library?.items, updates],
  )
  const availability = library
    ? describeEnterpriseSkillsAvailability(library.availability)
    : null
  const enabled = library?.availability.enabled === true
  const installedCount = countInstalledEnterpriseSkills(installedSkills)
  const actionDisabled = !enabled || !workspaceSlug || loading

  const install = React.useCallback(async (item: EnterpriseSkillLibraryItem, action: 'install' | 'update') => {
    if (installingId || actionDisabled) return
    const api = window.electronAPI as Partial<typeof window.electronAPI>
    if (typeof api.installEnterpriseSkill !== 'function') {
      toast.error('当前版本未提供企业 Skill 安装接口')
      return
    }
    setInstallingId(item.id)
    try {
      const result = await api.installEnterpriseSkill(workspaceSlug, {
        id: item.id,
        slug: item.slug,
        ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
        latestVersion: item.latestVersion,
      })
      toast.success(action === 'update' ? '企业 Skill 已更新' : '企业 Skill 已安装', {
        description: `${result.installedVersion} · ${item.slug}`,
      })
      onChanged()
    } catch (reason) {
      toast.error('企业 Skill 安装失败', { description: errorMessage(reason) })
    } finally {
      setInstallingId(null)
    }
  }, [actionDisabled, installingId, onChanged, workspaceSlug])

  const checkUpdates = React.useCallback(async () => {
    if (checking || !workspaceSlug) return
    const enterpriseSkills = installedSkills.filter((skill) => Boolean(skill.enterpriseSource))
    if (enterpriseSkills.length === 0) {
      toast.info('当前项目还没有已安装的企业 Skill')
      return
    }
    const api = window.electronAPI as Partial<typeof window.electronAPI>
    if (typeof api.checkEnterpriseSkillUpdates !== 'function') {
      toast.error('当前版本未提供企业 Skill 更新检查接口')
      return
    }
    setChecking(true)
    try {
      const result = await api.checkEnterpriseSkillUpdates(
        workspaceSlug,
        enterpriseSkills.map((skill) => ({ slug: skill.slug })),
      )
      setUpdates(result.updates)
      setLastCheckedAt(Date.now())
      if (result.updates.length > 0) {
        toast.info(`发现 ${result.updates.length} 个企业 Skill 可更新`)
      } else {
        toast.success('企业 Skill 均为最新版本')
      }
    } catch (reason) {
      toast.error('检查企业 Skill 更新失败', { description: errorMessage(reason) })
    } finally {
      setChecking(false)
    }
  }, [checking, installedSkills, workspaceSlug])

  if (!workspaceSlug) return null

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Store className="size-4 text-foreground/45" />
        <span className="text-[13px] font-medium text-foreground/55">企业 Skills</span>
        <span className="text-[12px] tabular-nums text-foreground/35">{rows.length}</span>
        {installedCount > 0 && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
            已安装 {installedCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            disabled={loading}
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            disabled={checking || installedCount === 0 || !enabled}
            onClick={() => void checkUpdates()}
          >
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            检查更新
          </Button>
        </div>
      </div>

      {availability && availability.tone === 'unavailable' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          <Building2 className="mt-0.5 size-3.5 shrink-0" />
          <span>{availability.message}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] px-3 py-2 text-[12px] text-destructive">
          <span className="flex-1">{error}</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setRefreshToken((value) => value + 1)}>
            重试
          </Button>
        </div>
      )}

      {updates.length > 0 && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-3 py-2 text-[12px] text-blue-600 dark:text-blue-400">
          有 {updates.length} 个已安装的企业 Skill 可更新
          {lastCheckedAt ? ` · ${new Date(lastCheckedAt).toLocaleTimeString()}` : ''}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-border/60 px-4 py-6 text-center text-[12px] text-muted-foreground">
          <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
          正在读取企业 Skills 库
        </div>
      ) : enabled && rows.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-[12px] text-muted-foreground">
          企业库暂无可用 Skill
        </div>
      ) : rows.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {rows.map((row) => {
            const sourceItem = library?.items.find((item) => item.id === row.id)
            const installing = installingId === row.id
            return (
              <div key={row.id} className="flex items-start gap-3 rounded-xl border border-border/60 bg-foreground/[0.015] p-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{row.name}</span>
                    <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      v{row.latestVersion.version}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {row.description || '暂无描述'}
                  </p>
                  {row.installedVersion && (
                    <p className="mt-1 text-[10px] text-muted-foreground/70">
                      已安装 v{row.installedVersion}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={row.action === 'installed' ? 'ghost' : 'default'}
                  className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                  disabled={actionDisabled || installing || row.action === 'installed' || !sourceItem}
                  onClick={() => {
                    if (sourceItem && row.action !== 'installed') void install(sourceItem, row.action)
                  }}
                >
                  {installing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : row.action === 'installed' ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  {row.action === 'installed' ? '已安装' : row.action === 'update' ? '更新' : '安装'}
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
