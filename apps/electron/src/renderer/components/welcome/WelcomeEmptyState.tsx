/**
 * WelcomeEmptyState — 对话/会话空状态引导
 *
 * 在没有会话时展示：
 * 1. 个性化时段问候
 * 2. 平台感知的小 Tips
 * 3. Agent标识
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Lightbulb, Bot } from 'lucide-react'

import { userProfileAtom } from '@/atoms/user-profile'

import { themeStyleAtom } from '@/atoms/theme'
import { getRandomTip, getPlatform, type Tip } from '@/lib/tips'

/** 根据小时返回时段问候 */
function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function WelcomeEmptyState(): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const themeStyle = useAtomValue(themeStyleAtom)

  // 稳定的随机 Tip（组件挂载时选一条）
  const [tip] = React.useState<Tip>(() => getRandomTip(getPlatform()))

  const hour = new Date().getHours()
  const greeting = getGreeting(hour)
  const displayName = userProfile.userName || '用户'

  // 森息晨光主题下选中按钮使用主色
  const selectedColor = themeStyle === 'forest-light' ? '#4a7858' : undefined

  return (
    <div className="welcome-empty-state flex h-full flex-col items-center justify-center gap-6 px-4">
      {/* 问候语 */}
      <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
        {displayName}，{greeting}
      </h1>

      {/* Tips */}
      <div className="flex items-center gap-2.5 rounded-full bg-muted/50 px-4 py-2 text-[13px] text-muted-foreground">
        <Lightbulb size={14} className="flex-shrink-0 text-amber-500/80" />
        <span>{tip.text}</span>
      </div>

      {/* Agent标识 */}
      <div className="flex items-center gap-1.5 rounded-xl bg-muted/60 px-5 py-2 text-[13px] font-medium" style={selectedColor ? { color: selectedColor } : undefined}><Bot size={15} />Agent</div>
    </div>
  )
}
