/**
 * 侧栏标题跑马灯（官方 0.22.80）。
 *
 * 只有文本被截断时才在悬停后滚动；离开立即复位。使用 CSS 动画，
 * 尊重系统的“减少动态效果”偏好，不改变行高与会话排序。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface MarqueeTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string
  /** 动画时长（秒），越长滚动越慢。 */
  durationSeconds?: number
}

export function shouldMarquee(scrollWidth: number, clientWidth: number): boolean {
  return Number.isFinite(scrollWidth) && Number.isFinite(clientWidth)
    && clientWidth > 0
    && scrollWidth > clientWidth + 1
}

export function MarqueeText({
  text,
  durationSeconds = 6,
  className,
  onMouseEnter,
  onMouseLeave,
  ...props
}: MarqueeTextProps): React.ReactElement {
  const outerRef = React.useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)

  React.useEffect(() => {
    const element = outerRef.current
    if (!element) return
    setOverflowing(shouldMarquee(element.scrollWidth, element.clientWidth))
  }, [text])

  const animate = hovered && overflowing

  return (
    <span
      ref={outerRef}
      className={cn('block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap', className)}
      onMouseEnter={(event) => {
        setHovered(true)
        onMouseEnter?.(event)
      }}
      onMouseLeave={(event) => {
        setHovered(false)
        onMouseLeave?.(event)
      }}
      {...props}
    >
      <span
        className={cn('inline-block', animate && 'sidebar-title-marquee')}
        style={animate ? { animationDuration: `${durationSeconds}s` } : undefined}
      >
        {text}
      </span>
    </span>
  )
}
