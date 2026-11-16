/**
 * 渠道卡片与授权成功提示
 *
 * 卡片是列表视图的唯一入口：点击或键盘 Enter/空格进入详情；
 * 启用开关与删除按钮各自拦截事件，避免误触打开详情。
 */

import * as React from 'react'
import { ArrowLeft, CheckCircle2, Trash2, TriangleAlert, X } from 'lucide-react'
import { PROVIDER_LABELS } from '@proma/shared'
import type { Channel } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { getChannelLogo } from '@/lib/model-logo'
import type { ChannelCardData } from './channel-cards'

interface ChannelCardProps {
  card: ChannelCardData
  /** 是否为 Agent 当前使用的渠道 */
  isCurrent: boolean
  onOpen: () => void
  onToggle: () => void
  onDelete: () => void
}

export function ChannelCard({ card, isCurrent, onOpen, onToggle, onDelete }: ChannelCardProps): React.ReactElement {
  const { channel } = card
  const endpoint = channel.baseUrl.trim()
    ? channel.baseUrl.trim().replace(/^https?:\/\//, '')
    : '订阅账号授权'

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`打开渠道 ${channel.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-3 rounded-xl border border-border/60 bg-content-area p-4 text-left',
        'transition-[border-color,box-shadow] hover:border-border hover:shadow-sm',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        !channel.enabled && 'bg-muted/35',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]">
          <img src={getChannelLogo(channel)} alt="" className="size-6 rounded-sm object-contain" />
        </div>
        <div className="min-w-0 flex-1 pr-9">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate text-[15px] font-semibold text-foreground">{channel.name}</h4>
            <CardTag>{card.providerLabel}</CardTag>
            {isCurrent && <CardTag tone="current">当前使用</CardTag>}
            {!channel.enabled && <CardTag tone="muted">已停用</CardTag>}
          </div>
          <p className="mt-1 truncate text-[12px] text-muted-foreground">{endpoint}</p>
        </div>
      </div>

      {/* 启用开关位于右上角，与官方渠道卡片保持一致 */}
      <div
        className="absolute right-3 top-3.5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Switch
          checked={channel.enabled}
          onCheckedChange={onToggle}
          aria-label={channel.enabled ? `停用渠道 ${channel.name}` : `启用渠道 ${channel.name}`}
        />
      </div>

      <div className="flex min-h-[22px] flex-wrap items-center gap-1.5">
        {card.quotaSummary && (
          <span
            title="订阅额度"
            className="max-w-full truncate rounded bg-foreground/[0.045] px-1.5 py-0.5 text-[12px] text-foreground/70"
          >
            {card.quotaSummary}
          </span>
        )}
        {card.errorSummary && (
          <span
            title={card.errorTitle ?? card.errorSummary}
            className="flex min-w-0 items-center gap-1 text-[12px] text-destructive"
          >
            <TriangleAlert size={12} className="shrink-0" />
            <span className="truncate">{card.errorSummary}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border/50 pt-2.5 text-[12px] text-muted-foreground">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            channel.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        />
        <span className="tabular-nums">{card.modelCountLabel}</span>
        <div
          className="ml-auto flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="删除"
            aria-label={`删除渠道 ${channel.name}`}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 详情视图顶部：返回 + 渠道标识；表单与模型列表仍由 ChannelForm 负责。 */
export function ChannelDetailHeader({
  channel,
  onBack,
}: {
  channel: Channel
  onBack: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onBack}
        aria-label="返回渠道列表"
      >
        <ArrowLeft size={18} />
      </Button>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]">
        <img src={getChannelLogo(channel)} alt="" className="size-6 rounded-sm object-contain" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-lg font-medium text-foreground">{channel.name}</h3>
          <CardTag>{PROVIDER_LABELS[channel.provider]}</CardTag>
          {!channel.enabled && <CardTag tone="muted">已停用</CardTag>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">进入时刷新模型与订阅额度；修改会自动保存。</p>
      </div>
    </div>
  )
}

function CardTag({
  children,
  tone = 'default',
}: {
  children: React.ReactNode
  tone?: 'default' | 'current' | 'muted'
}): React.ReactElement {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'current' && 'bg-primary/10 text-primary',
        tone === 'default' && 'bg-muted text-muted-foreground',
        tone === 'muted' && 'bg-muted text-muted-foreground/80',
      )}
    >
      {children}
    </span>
  )
}

interface ChannelAuthorizationNoticeProps {
  channel: Channel
  onViewModels: () => void
  onDismiss: () => void
}

/** 新建订阅渠道后的成功反馈，避免表单自动返回列表时错过短暂 toast。 */
export function ChannelAuthorizationNotice({
  channel,
  onViewModels,
  onDismiss,
}: ChannelAuthorizationNoticeProps): React.ReactElement {
  const enabledModelCount = channel.models.filter((model) => model.enabled).length
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-4 py-3 text-emerald-950 shadow-[0_1px_2px_rgba(16,185,129,0.08)] dark:text-emerald-100"
    >
      <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-wrap-pretty">GitHub Copilot 已授权并保存</p>
        <p className="mt-0.5 text-xs leading-5 text-emerald-800/80 dark:text-emerald-200/80">
          已启用 <span className="font-medium tabular-nums">{enabledModelCount}</span> 个当前订阅可用模型；现在可在 Agent 的模型选择器中使用。
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onViewModels}
          className="mt-1 h-7 px-0 text-emerald-800 hover:text-emerald-950 dark:text-emerald-200 dark:hover:text-emerald-50"
        >
          查看已启用模型
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-emerald-800/70 transition-colors hover:bg-emerald-500/10 hover:text-emerald-950 active:scale-[0.96] dark:text-emerald-200/70 dark:hover:text-emerald-50"
        title="关闭授权成功提示"
        aria-label="关闭授权成功提示"
      >
        <X size={16} />
      </button>
    </div>
  )
}
