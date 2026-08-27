/**
 * PersonalDirectiveToggle — Agent「破甲」个人指令切换器
 *
 * 在 Agent 输入工具栏提供「破甲：开启 / 关闭」运行时开关。
 * 状态持久化到 settings.json 的 personalDirective.enabled；
 * 开启后主进程会把 personalDirective.content 追加进 Agent 系统提示词。
 * 开关只影响后续模型请求，不修改已经发出的请求。
 *
 * 健壮性约定：
 * - 读取/写入失败时用 toast 明确提示，绝不静默回退；
 * - 读取失败时中止本次切换，绝不把 content 清空或写成空串。
 */

import * as React from 'react'
import { Flame, FlameKindling } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom } from 'jotai'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { inputToolbarButtonClass, inputToolbarActiveButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { personalDirectiveEnabledAtom } from '@/atoms/personal-directive-atoms'

/** PersonalDirectiveToggle 属性接口 */
interface PersonalDirectiveToggleProps {
  className?: string
}

export function PersonalDirectiveToggle({ className }: PersonalDirectiveToggleProps): React.ReactElement | null {
  // 与 ArmorRefusalBadge 共用同一 atom，切换时徽标即时跟随。
  const [enabled, setEnabled] = useAtom(personalDirectiveEnabledAtom)
  const [loaded, setLoaded] = React.useState(false)

  /** 挂载时读取当前设置，回填共享开关状态（幂等） */
  React.useEffect(() => {
    let mounted = true
    window.electronAPI.getSettings()
      .then((s) => {
        if (!mounted) return
        setEnabled(s.personalDirective?.enabled ?? false)
        setLoaded(true)
      })
      .catch((error) => {
        if (!mounted) return
        console.error('[PersonalDirectiveToggle] 读取设置失败:', error)
        toast.error('读取破甲开关失败', { description: String(error) })
        setLoaded(true)
      })
    return (): void => { mounted = false }
  }, [setEnabled])

  /** 翻转开关；失败时 toast 提示并回滚，绝不静默、绝不清空 content */
  const toggle = React.useCallback(async (): Promise<void> => {
    const previous = enabled
    const next = !enabled

    // 读取最新设置，拿到当前 content；读取失败则中止，避免写坏 content
    const current = await window.electronAPI.getSettings().catch((error) => {
      console.error('[PersonalDirectiveToggle] 读取设置失败，已中止切换:', error)
      toast.error('切换破甲失败', { description: '读取设置失败：' + String(error) })
      return undefined
    })
    if (!current) return

    const pd = current.personalDirective
    const content = pd?.content ?? ''
    const markdownPath = (pd?.markdownPath ?? '').trim()

    // 开启时校验 markdownPath 指向的 .md 文件是否存在；缺失则提示并中止开启。
    if (next && markdownPath.length > 0) {
      const fileCheck = await window.electronAPI.checkPersonalDirectiveFile().catch(() => null)
      if (fileCheck && !fileCheck.exists) {
        toast.error('破甲提示词文件不存在', { description: fileCheck.resolvedPath || markdownPath })
        return
      }
    }

    if (content.trim().length === 0 && markdownPath.length === 0) {
      toast.error('破甲指令内容为空', { description: '请在 settings.json 配置 personalDirective.content 或 markdownPath' })
      return
    }

    setEnabled(next)
    try {
      await window.electronAPI.updateSettings({ personalDirective: { enabled: next, content, markdownPath } })
      toast.success(next ? '破甲：已开启' : '破甲：已关闭', {
        description: next ? '已注入提示词，后续请求生效' : '已停止注入，保持默认行为',
      })
    } catch (error) {
      console.error('[PersonalDirectiveToggle] 切换失败，回滚 UI:', error)
      setEnabled(previous)
      toast.error(next ? '开启破甲失败' : '关闭破甲失败', { description: String(error) })
    }
  }, [enabled])

  if (!loaded) return null

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={enabled}
            aria-label={enabled ? '破甲：开启' : '破甲：关闭'}
            onClick={() => { void toggle(); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
            className={cn(inputToolbarButtonClass, enabled && inputToolbarActiveButtonClass, className)}
          >
            {enabled ? <Flame className="size-5" /> : <FlameKindling className="size-5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px]">
          <p className="font-medium">{enabled ? '破甲：开启' : '破甲：关闭'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {enabled ? '已注入「个人指令（破甲）」到 Agent 系统提示词' : '未注入，保持默认行为'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">点击切换，仅影响后续请求</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
