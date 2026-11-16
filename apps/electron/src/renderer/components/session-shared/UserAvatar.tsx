/**
 * UserAvatar - 用户头像组件
 *
 * 对标 Cherry Studio 的 EmojiAvatar 设计：
 * - 支持 emoji 字符串（直接渲染文字）
 * - 支持 data:image/* URL（渲染为图片）
 * - 可配置大小
 * - 圆角 20%，柔和边框
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { DEFAULT_USER_AVATAR } from '../../../types/user-profile'

interface UserAvatarProps {
  /** 头像内容（emoji 字符串 或 data:image/* URL） */
  avatar: string
  /** 尺寸（像素），默认 35 */
  size?: number
  className?: string
  onClick?: React.MouseEventHandler<HTMLDivElement>
}

/** 判断是否为图片 URL（data:image 或 http） */
function isImageUrl(avatar: string): boolean {
  return avatar.startsWith('data:image') || avatar.startsWith('http')
}

/** 每个 src 独立挂载，旧图片迟到的 load/error 不会改变新头像的状态。 */
function ImageAvatar({ avatar, size = 35, className, onClick }: UserAvatarProps): React.ReactElement {
  const [status, setStatus] = React.useState<'loading' | 'loaded' | 'error'>('loading')
  const attachImage = React.useCallback((image: HTMLImageElement | null) => {
    // 缓存命中时 load 可能早于挂载，直接核对已解码的原生图片状态。
    if (image?.complete) setStatus(image.naturalWidth > 0 ? 'loaded' : 'error')
  }, [])

  return (
    <div
      role="img"
      aria-label="用户头像"
      data-avatar-state={status}
      className={cn(
        'relative shrink-0 flex items-center justify-center overflow-hidden rounded-[20%]',
        'bg-foreground/[0.04] dark:bg-foreground/[0.08] border-[0.5px] border-foreground/10',
        onClick && 'cursor-pointer hover:opacity-80 transition-opacity',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      onClick={onClick}
    >
      {status !== 'loaded' && <span aria-hidden="true">{DEFAULT_USER_AVATAR}</span>}
      {status !== 'error' && (
        <img
          ref={attachImage}
          src={avatar}
          alt=""
          aria-hidden="true"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          className={cn('absolute inset-0 size-full object-cover', status === 'loaded' ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  )
}

export function UserAvatar({
  avatar,
  size = 35,
  className,
  onClick,
}: UserAvatarProps): React.ReactElement {
  const fontSize = Math.round(size * 0.5)

  if (isImageUrl(avatar)) {
    return <ImageAvatar key={avatar} avatar={avatar} size={size} className={className} onClick={onClick} />
  }

  // emoji 渲染
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-center rounded-[20%]',
        'bg-foreground/[0.04] dark:bg-foreground/[0.08] border-[0.5px] border-foreground/10',
        onClick && 'cursor-pointer hover:opacity-80 transition-opacity',
        className
      )}
      style={{ width: size, height: size, fontSize }}
      onClick={onClick}
    >
      {avatar}
    </div>
  )
}
