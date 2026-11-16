/**
 * ChannelSettings - 模型设置（渠道卡片 + 详情视图）
 *
 * 列表以卡片展示渠道；点击卡片进入详情，复用 ChannelForm 编辑。
 * 进入详情时按需刷新该渠道的模型与订阅额度，不做后台轮询。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Loader2, Plus, X } from 'lucide-react'
import type { Channel, ChannelPlanQuotaResult } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { agentChannelIdAtom, agentModelIdAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/channel-atoms'
import { fetchChannelPlanQuota, getCachedPlanQuota, supportsChannelPlanQuota } from '@/lib/channel-plan-quota'
import { SettingsCard, SettingsSection } from './primitives'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ChannelAuthorizationNotice, ChannelCard, ChannelDetailHeader } from './ChannelCard'
import { buildChannelCards, hasModelListChanges, isQuotaFailure } from './channel-cards'
import { mergeFetchedChannelModels } from './channel-model-state'
import { ChannelForm } from './ChannelForm'
import { ReasoningProfileSettings } from './ReasoningProfileSettings'

type ViewMode = 'list' | 'create' | 'detail'

/** 模型目录刷新节流：刚刷新过的渠道不重复请求；失败不记时间，下次进入立即重试。 */
const MODEL_REFRESH_TTL_MS = 60_000
const lastModelRefreshAt = new Map<string, number>()
const inflightModelRefreshes = new Map<string, Promise<Channel | null>>()

async function refreshChannelModels(channel: Channel): Promise<Channel | null> {
  const last = lastModelRefreshAt.get(channel.id)
  if (last !== undefined && Date.now() - last < MODEL_REFRESH_TTL_MS) return null

  const key = `${channel.id}:${channel.updatedAt}`
  const inflight = inflightModelRefreshes.get(key)
  if (inflight) return inflight

  const task = (async (): Promise<Channel | null> => {
    if (!channel.apiKey) return null
    const apiKey = await window.electronAPI.decryptApiKey(channel.id)
    if (!apiKey.trim()) return null
    const result = await window.electronAPI.fetchModels({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
    })
    if (!result.success) throw new Error(result.message || '获取模型失败')
    // 空清单可能是供应商分页/临时异常，进入刷新时不能据此清空已有模型。
    if (result.models.length === 0) return null
    // 进入刷新只合并清单，不自动启用新模型，避免改变用户的选择。
    const merged = mergeFetchedChannelModels(channel.models, result.models, false)
    lastModelRefreshAt.set(channel.id, Date.now())
    if (!hasModelListChanges(channel.models, merged)) return null
    return await window.electronAPI.updateChannel(channel.id, { models: merged })
  })()

  inflightModelRefreshes.set(key, task)
  try {
    return await task
  } catch (error) {
    lastModelRefreshAt.delete(channel.id)
    throw error
  } finally {
    inflightModelRefreshes.delete(key)
  }
}

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const setGlobalChannels = useSetAtom(channelsAtom)
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom)
  const [, setAgentModelId] = useAtom(agentModelIdAtom)
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [detailChannel, setDetailChannel] = React.useState<Channel | null>(null)
  const detailChannelRef = React.useRef<Channel | null>(null)
  const [detailReady, setDetailReady] = React.useState(false)
  const [refreshNotice, setRefreshNotice] = React.useState<string | null>(null)
  const [refreshErrors, setRefreshErrors] = React.useState<Record<string, string>>({})
  const [quotaByChannel, setQuotaByChannel] = React.useState<Record<string, ChannelPlanQuotaResult>>({})
  const [loading, setLoading] = React.useState(true)
  const [deleteTarget, setDeleteTarget] = React.useState<Channel | null>(null)
  const [recentlyAuthorizedChannel, setRecentlyAuthorizedChannel] = React.useState<Channel | null>(null)

  /** 加载渠道列表并同步全局缓存 */
  const loadChannels = React.useCallback(async (): Promise<Channel[]> => {
    try {
      const list = await window.electronAPI.listChannels()
      setChannels(list)
      setGlobalChannels(list)
      return list
    } catch (error) {
      console.error('[渠道设置] 加载渠道列表失败:', error)
      return []
    } finally {
      setLoading(false)
    }
  }, [setGlobalChannels])

  React.useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  /** 记录/清除某个渠道的最近错误 */
  const setChannelError = React.useCallback((channelId: string, message: string | null): void => {
    setRefreshErrors((prev) => {
      if (message === null) {
        if (!(channelId in prev)) return prev
        const next = { ...prev }
        delete next[channelId]
        return next
      }
      return { ...prev, [channelId]: message }
    })
  }, [])

  const openChannel = React.useCallback((channel: Channel): void => {
    detailChannelRef.current = channel
    setDetailChannel(channel)
    setRefreshNotice(null)
    setDetailReady(false)
    setViewMode('detail')
  }, [])

  const backToList = React.useCallback((): void => {
    detailChannelRef.current = null
    setDetailChannel(null)
    setViewMode('list')
  }, [])

  /** 进入详情：刷新模型与额度；失败保留旧数据并给出提示。 */
  React.useEffect(() => {
    if (viewMode !== 'detail' || !detailChannel?.id) return
    const channel = detailChannelRef.current
    if (!channel) return
    let cancelled = false
    setDetailReady(false)
    setRefreshNotice(null)

    void (async () => {
      let latest = channel
      try {
        const refreshed = await refreshChannelModels(channel)
        if (refreshed) {
          latest = refreshed
          // 即使已经返回列表也同步列表数据，避免刷新写入后卡片仍是旧模型数。
          setChannels((prev) => prev.map((item) => (item.id === refreshed.id ? refreshed : item)))
          setGlobalChannels((prev) => prev.map((item) => (item.id === refreshed.id ? refreshed : item)))
          if (!cancelled) {
            detailChannelRef.current = refreshed
            setDetailChannel(refreshed)
          }
        }
        if (cancelled) return
        setChannelError(channel.id, null)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : '未知错误'
        setChannelError(channel.id, `模型刷新失败：${message}`)
        setRefreshNotice(`模型刷新失败，已保留原有模型：${message}`)
      }
      if (cancelled) return
      setDetailReady(true)

      if (!supportsChannelPlanQuota(latest)) return
      const quota = await fetchChannelPlanQuota(latest.id, latest.updatedAt)
      if (cancelled) return
      // 查询失败时保留上一次成功摘要，不把卡片额度清空或归零。
      setQuotaByChannel((prev) => {
        if (isQuotaFailure(quota) && prev[latest.id]) return prev
        return { ...prev, [latest.id]: quota }
      })
      if (isQuotaFailure(quota) && quota.message) {
        setRefreshNotice((prev) => prev ?? `订阅额度查询失败，已保留原有摘要：${quota.message}`)
      }
    })()

    return () => {
      cancelled = true
    }
    // 仅在进入详情或切换渠道时触发；同 id 渠道的数据更新不会重新跑。
  }, [viewMode, detailChannel?.id, setChannelError, setGlobalChannels])

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    try {
      await window.electronAPI.deleteChannel(target.id)
      if (agentChannelId === target.id) {
        setAgentChannelId(null)
        setAgentModelId(null)
      }
      await window.electronAPI.updateSettings({
        ...(agentChannelId === target.id && { agentChannelId: undefined, agentModelId: undefined }),
      })
      setChannelError(target.id, null)
      await loadChannels()
      setDeleteTarget(null)
    } catch (error) {
      console.error('[渠道设置] 删除渠道失败:', error)
    }
  }

  const handleToggle = async (channel: Channel): Promise<void> => {
    try {
      await window.electronAPI.updateChannel(channel.id, { enabled: !channel.enabled })
      await loadChannels()
    } catch (error) {
      console.error('[渠道设置] 切换渠道状态失败:', error)
      setChannelError(channel.id, '切换启用状态失败，请重试')
    }
  }

  const handleFormSaved = async (savedChannel?: Channel): Promise<void> => {
    backToList()
    const latestChannels = await loadChannels()
    if (savedChannel?.provider === 'github-copilot') {
      // 使用落库后的对象，确保模型计数与 enabled 状态和列表完全一致。
      setRecentlyAuthorizedChannel(latestChannels.find((channel) => channel.id === savedChannel.id) ?? savedChannel)
    }
  }

  const cards = React.useMemo(() => buildChannelCards(channels, {
    quotaOf: (channel) => quotaByChannel[channel.id] ?? getCachedPlanQuota(channel.id, channel.updatedAt),
    errorOf: (channel) => refreshErrors[channel.id],
  }), [channels, quotaByChannel, refreshErrors])

  if (viewMode === 'create') {
    return <ChannelForm channel={null} onSaved={handleFormSaved} onCancel={backToList} />
  }
  if (viewMode === 'detail' && detailChannel) {
    return (
      <div className="space-y-6">
        <ChannelDetailHeader channel={detailChannel} onBack={backToList} />

        {refreshNotice && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive"
          >
            <span className="min-w-0 flex-1">{refreshNotice}</span>
            <button
              type="button"
              onClick={() => setRefreshNotice(null)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-destructive/10"
              aria-label="关闭刷新提示"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {detailReady ? (
          <ChannelForm
            key={detailChannel.id}
            channel={detailChannel}
            onSaved={handleFormSaved}
            onCancel={backToList}
          />
        ) : (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-content-area py-12 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            正在刷新渠道信息…
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="模型配置"
        description="管理 AI 供应商连接，配置 API Key 和可用模型。"
        action={
          <Button size="sm" onClick={() => setViewMode('create')}>
            <Plus size={16} />
            <span>添加配置</span>
          </Button>
        }
      >
        {recentlyAuthorizedChannel && (
          <ChannelAuthorizationNotice
            channel={recentlyAuthorizedChannel}
            onViewModels={() => {
              const target = recentlyAuthorizedChannel
              setRecentlyAuthorizedChannel(null)
              if (target) openChannel(target)
            }}
            onDismiss={() => setRecentlyAuthorizedChannel(null)}
          />
        )}
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : cards.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <p className="text-sm text-muted-foreground">还没有配置任何模型</p>
              <Button size="sm" onClick={() => setViewMode('create')}>
                <Plus size={16} />
                <span>添加配置</span>
              </Button>
            </div>
          </SettingsCard>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <ChannelCard
                key={card.channel.id}
                card={card}
                isCurrent={agentChannelId === card.channel.id}
                onOpen={() => openChannel(card.channel)}
                onToggle={() => void handleToggle(card.channel)}
                onDelete={() => setDeleteTarget(card.channel)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 区块二：推理能力配置（levels / thinkingLevelMap / reasoning / 匹配规则） */}
      <ReasoningProfileSettings />

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定删除渠道？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除渠道「{deleteTarget?.name}」？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
