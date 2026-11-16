/**
 * PersonalDirectiveToggle — Agent「破甲」会话级开关
 *
 * 破甲是**会话级**状态：每个会话独立维护，新建会话默认关闭。
 *
 * 分工：
 * - `settings.personalDirective`（全局）决定「破甲装了什么」：正文、技能根、MCP 配置。
 * - `sessionMeta.armorEnabled`（会话级）决定「本会话用不用」。
 *   两者都开才注入提示词与技能根。
 *
 * 所以本开关只写会话元数据，绝不改全局 settings —— 否则一个会话的开关
 * 会污染其它会话，正是这个组件要修掉的行为。
 *
 * 健壮性约定：
 * - 读取/写入失败时用 toast 明确提示，绝不静默回退；
 * - 全局破甲未配置内容时，开启会明确提示先去配置，而不是假装成功；
 * - 「是否已配置」一律现读 settings.json 判定，不依赖可能过期的内存状态。
 */

import * as React from 'react'
import { Flame, FlameKindling } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { inputToolbarButtonClass, inputToolbarActiveButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { agentSessionsAtom, sessionArmorEnabledAtom } from '@/atoms/agent-atoms'
import { inspectPersonalDirective, type PersonalDirectiveConfigState } from '@/lib/personal-directive-config'

/** PersonalDirectiveToggle 属性接口 */
interface PersonalDirectiveToggleProps {
  /** 当前会话 ID；破甲状态按会话存储 */
  sessionId: string
  className?: string
}

export function PersonalDirectiveToggle({ sessionId, className }: PersonalDirectiveToggleProps): React.ReactElement | null {
  // 会话级状态：直接由 sessions atom 派生，切换后无需本地副本
  const enabled = useAtomValue(sessionArmorEnabledAtom(sessionId))
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  // 全局配置状态；null 表示还没读到，避免挂载瞬间把「未知」误判成「未配置」
  const [configState, setConfigState] = React.useState<PersonalDirectiveConfigState | null>(null)
  const [pending, setPending] = React.useState(false)

  /** 挂载时读取全局配置，供提示文案使用；不决定本会话开关 */
  React.useEffect(() => {
    let mounted = true
    window.electronAPI.getSettings()
      .then((settings) => {
        if (mounted) setConfigState(inspectPersonalDirective(settings.personalDirective))
      })
      .catch((error) => {
        console.error('[PersonalDirectiveToggle] 读取破甲配置失败:', error)
      })
    return (): void => { mounted = false }
  }, [])

  /** 翻转本会话开关；只写会话元数据 */
  const toggle = React.useCallback(async (): Promise<void> => {
    if (pending) return
    const next = !enabled

    setPending(true)
    try {
      if (next) {
        // 以磁盘上的最新配置为准：挂载时读到的状态可能已被用户改过。
        const settings = await window.electronAPI.getSettings()
        const state = inspectPersonalDirective(settings.personalDirective)
        setConfigState(state)

        if (state === 'disabled') {
          toast.error('破甲未启用', {
            description: '请在 settings.json 把 personalDirective.enabled 设为 true',
          })
          return
        }
        if (state === 'empty') {
          toast.error('破甲未配置正文', {
            description: '请先在 settings.json 的 personalDirective 配置 markdownPath 或 content',
          })
          return
        }

        // markdownPath 指向的文件可能已被删除或改名，开启前校验一次。
        const markdownPath = (settings.personalDirective?.markdownPath ?? '').trim()
        if (markdownPath.length > 0) {
          const fileCheck = await window.electronAPI.checkPersonalDirectiveFile().catch(() => null)
          if (fileCheck && !fileCheck.exists) {
            toast.error('破甲提示词文件不存在', { description: fileCheck.resolvedPath || markdownPath })
            return
          }
        }
      }

      // 先本地翻转，避免等待 IPC 期间按钮状态滞后；主进程返回后再以权威元数据覆盖。
      setAgentSessions((prev) => prev.map((item) => (
        item.id === sessionId ? { ...item, armorEnabled: next } : item
      )))

      const updated = await window.electronAPI.updateSessionArmor(sessionId, next)
      setAgentSessions((prev) => prev.map((item) => (item.id === sessionId ? updated : item)))
      toast.success(next ? '本会话破甲：开启' : '本会话破甲：关闭', {
        description: next ? '仅本会话生效，后续请求注入破甲正文' : '仅本会话生效，其它会话不受影响',
      })
    } catch (error) {
      // 乐观更新失败时回滚本会话状态，UI 不能停留在未生效的「已开启」。
      setAgentSessions((prev) => prev.map((item) => (
        item.id === sessionId ? { ...item, armorEnabled: enabled } : item
      )))
      console.error('[PersonalDirectiveToggle] 切换失败:', error)
      toast.error(next ? '开启破甲失败' : '关闭破甲失败', { description: String(error) })
    } finally {
      setPending(false)
    }
  }, [enabled, pending, sessionId, setAgentSessions])

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={enabled}
            aria-label={enabled ? '本会话破甲：开启' : '本会话破甲：关闭'}
            disabled={pending}
            onClick={() => { void toggle(); requestAnimationFrame(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus()) }}
            className={cn(inputToolbarButtonClass, enabled && inputToolbarActiveButtonClass, className)}
          >
            {enabled ? <Flame className="size-5" /> : <FlameKindling className="size-5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px]">
          <p className="font-medium">{enabled ? '本会话破甲：开启' : '本会话破甲：关闭'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {configState === null
              ? '开启时会重新校验全局破甲配置'
              : configState === 'disabled'
                ? '全局破甲未启用（personalDirective.enabled 为 false）'
                : configState === 'empty'
                  ? '全局未配置破甲正文，开启前需先配置'
                  : enabled
                    ? '已注入破甲正文与技能根，仅本会话'
                    : '未注入，保持默认行为'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            会话级开关：新建会话默认关闭
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
