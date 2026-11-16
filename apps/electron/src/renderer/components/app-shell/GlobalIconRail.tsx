/**
 * 全局图标栏（官方 0.22.0 左侧第一列）。
 *
 * 常驻显示，不随分区侧栏折叠：首页、清单、日程、Obsidian、收藏会话、
 * 记忆、定时任务、MCP/Skills，底部为头像设置入口。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Blocks,
  Bookmark,
  CalendarDays,
  Clock,
  Home,
  ListChecks,
  NotebookText,
  PanelLeft,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { UserAvatar } from '@/components/session-shared/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { hasUpdateAtom } from '@/atoms/updater'
import { hasEnvironmentIssuesAtom } from '@/atoms/environment'
import { activeViewAtom, agentSkillsTabAtom } from '@/atoms/active-view'
import { planningTabAtom } from '@/atoms/planning-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { effectiveSidebarCollapsedAtom } from '@/atoms/preview-sidebar-atoms'
import { productivityToolsAtom } from '@/atoms/ui-preferences'
import { cn } from '@/lib/utils'
import { detectIsMac } from '@/lib/platform'

/** 与 AppShell 的折叠宽度保持一致。 */
export const GLOBAL_ICON_RAIL_WIDTH = 53

type RailSection =
  | 'conversations'
  | 'todos'
  | 'calendar'
  | 'vault'
  | 'starred'
  | 'memory'
  | 'automations'
  | 'skills'

interface RailItem {
  id: RailSection
  label: string
  icon: React.ReactNode
}

interface RailButtonProps {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function RailButton({ label, active, onClick, children }: RailButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors titlebar-no-drag',
            active
              ? 'bg-foreground/[0.1] text-foreground'
              : 'text-muted-foreground/75 hover:bg-foreground/[0.06] hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function GlobalIconRail(): React.ReactElement {
  const activeView = useAtomValue(activeViewAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const planningTab = useAtomValue(planningTabAtom)
  const setPlanningTab = useSetAtom(planningTabAtom)
  const agentSkillsTab = useAtomValue(agentSkillsTabAtom)
  const setAgentSkillsTab = useSetAtom(agentSkillsTabAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const productivityTools = useAtomValue(productivityToolsAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(effectiveSidebarCollapsedAtom)
  const [settingsOpen, setSettingsOpen] = useAtom(settingsOpenAtom)
  const userProfile = useAtomValue(userProfileAtom)
  const hasUpdate = useAtomValue(hasUpdateAtom)
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom)
  // macOS 红绿灯占据左上角；图标栏与分区侧栏保持同一顶部留白。
  const isMac = detectIsMac()

  const items = React.useMemo<RailItem[]>(() => [
    ...(productivityTools.todosEnabled ? [{ id: 'todos' as const, label: '清单', icon: <ListChecks size={18} /> }] : []),
    ...(productivityTools.calendarEnabled ? [{ id: 'calendar' as const, label: '日程', icon: <CalendarDays size={18} /> }] : []),
    ...(productivityTools.obsidianEnabled ? [{ id: 'vault' as const, label: 'Obsidian', icon: <ObsidianIcon size={18} /> }] : []),
    { id: 'starred', label: '收藏会话', icon: <Bookmark size={18} /> },
    { id: 'memory', label: '记忆', icon: <NotebookText size={18} /> },
    { id: 'automations', label: '定时任务', icon: <Clock size={18} /> },
    { id: 'skills', label: 'MCP/Skills', icon: <Blocks size={18} /> },
  ], [
    activeView,
    productivityTools.calendarEnabled,
    productivityTools.obsidianEnabled,
    productivityTools.todosEnabled,
  ])

  const activeSection: RailSection = (() => {
    if (activeView === 'planning') {
      if (planningTab === 'calendar') return 'calendar'
      if (planningTab === 'automations') return 'automations'
      return 'todos'
    }
    if (activeView === 'vault') return 'vault'
    if (activeView === 'starred') return 'starred'
    if (activeView === 'agent-skills') return agentSkillsTab === 'memory' ? 'memory' : 'skills'
    return 'conversations'
  })()

  const openSection = React.useCallback((section: RailSection): void => {
    switch (section) {
      case 'conversations':
        setActiveView('conversations')
        break
      case 'todos':
        setPlanningTab('todos')
        setActiveView('planning')
        break
      case 'calendar':
        setPlanningTab('calendar')
        setActiveView('planning')
        break
      case 'automations':
        setAutomationForm({ open: false, draft: null })
        setPlanningTab('automations')
        setActiveView('planning')
        break
      case 'vault':
        setActiveView('vault')
        break
      case 'starred':
        setActiveView('starred')
        break
      case 'memory':
        setAgentSkillsTab('memory')
        setActiveView('agent-skills')
        break
      case 'skills':
        setAgentSkillsTab('skills')
        setActiveView('agent-skills')
        break
    }
  }, [setActiveView, setAgentSkillsTab, setAutomationForm, setPlanningTab])

  return (
    <nav
      aria-label="全局导航"
      className={cn(
        'flex h-full w-[53px] shrink-0 flex-col items-center border-r border-border/40 bg-[hsl(var(--sidebar-surface))]',
        isMac ? 'pt-[50px]' : 'pt-2',
      )}
    >
      {!sidebarCollapsed && activeSection !== 'conversations' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="返回 Proma Agent 首页"
              onClick={() => setActiveView('conversations')}
              className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground/75 transition-colors hover:bg-foreground/[0.06] hover:text-foreground titlebar-no-drag"
            >
              <Home size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>返回 Proma Agent 首页</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-pressed={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground/75 transition-colors hover:bg-foreground/[0.06] hover:text-foreground titlebar-no-drag"
            >
              <PanelLeft size={17} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          </TooltipContent>
        </Tooltip>
      )}

      <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5 py-1 scrollbar-none">
        {items.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            active={activeSection === item.id}
            onClick={() => openSection(item.id)}
          >
            {item.icon}
          </RailButton>
        ))}
      </div>

      <div className="flex w-full shrink-0 flex-col items-center pb-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="打开设置"
              aria-pressed={settingsOpen}
              onClick={() => setSettingsOpen(true)}
              className={cn(
                'relative flex size-9 items-center justify-center rounded-lg transition-colors titlebar-no-drag',
                settingsOpen ? 'bg-foreground/[0.1]' : 'hover:bg-foreground/[0.06]',
              )}
            >
              <UserAvatar avatar={userProfile.avatar} size={26} />
              {(hasEnvironmentIssues || hasUpdate) && (
                <span
                  className={cn(
                    'absolute right-1 top-1 size-2 rounded-full ring-2 ring-[hsl(var(--sidebar-surface))]',
                    hasEnvironmentIssues ? 'bg-red-500' : 'bg-blue-500',
                  )}
                  aria-label={hasEnvironmentIssues ? '环境检查需要处理' : '有新版本可用'}
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>{userProfile.userName || '设置'}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
