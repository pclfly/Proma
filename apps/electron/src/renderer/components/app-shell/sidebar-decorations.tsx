import { Clock, Folder, FolderOpen } from 'lucide-react'

interface SidebarProjectIconProps { collapsed: boolean; automation?: boolean }

/** 项目头的图标由同一状态入口渲染，普通/归档/重命名分支共用。 */
export function SidebarProjectIcon({ collapsed, automation = false }: SidebarProjectIconProps) {
  if (automation) return <Clock size={13} className="flex-shrink-0 text-foreground/40" />
  const Icon = collapsed ? Folder : FolderOpen
  return <Icon size={14} className="flex-shrink-0 text-[hsl(var(--sidebar-primary-foreground)/0.78)] dark:text-[hsl(var(--sidebar-primary-foreground)/0.65)]" />
}

/** 仅隐藏上层已经明确提供的同项目名称，跨项目合成组仍需要来源身份。 */
export function getSessionWorkspaceBadgeName(workspaceName: string | undefined, workspaceId: string | undefined, groupWorkspaceId: string | undefined): string | undefined {
  return workspaceId && workspaceId === groupWorkspaceId ? undefined : workspaceName
}

interface SessionWorkspaceBadgeProps { workspaceName?: string }

/** 会话行的项目徽标；调用方决定上层上下文是否已提供同一项目身份。 */
export function SessionWorkspaceBadge({ workspaceName }: SessionWorkspaceBadgeProps) {
  if (!workspaceName) return null
  return <span className="flex-shrink-0 px-1.5 py-0 rounded-full bg-primary/10 text-[10px] leading-4 workspace-badge font-medium truncate max-w-[80px]">{workspaceName}</span>
}
