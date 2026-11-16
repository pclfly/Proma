import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { SidebarProjectIcon, SessionWorkspaceBadge, getSessionWorkspaceBadgeName } from './sidebar-decorations'
import { groupArchivedAgentSessionsByProject } from '@/lib/agent-session-list'
import type { AgentSessionMeta, AgentWorkspace } from '@proma/shared'

describe('项目头与归档会话的实际装饰组件', () => {
  test('Given 普通项目 When 展开/折叠 Then 显示不同文件夹且不影响自动任务Clock', () => {
    const expanded = renderToStaticMarkup(<SidebarProjectIcon collapsed={false} />)
    const collapsed = renderToStaticMarkup(<SidebarProjectIcon collapsed />)
    expect(expanded).toContain('lucide-folder-open')
    expect(collapsed).toContain('lucide-folder')
    expect(collapsed).not.toContain('lucide-folder-open')
    expect(expanded).not.toBe(collapsed)
    for (const value of [true, false]) {
      expect(renderToStaticMarkup(<SidebarProjectIcon collapsed={value} automation />)).toContain('lucide-clock')
    }
  })
  test('Given 已归档父/子会话 When 渲染共同徽标 Then 不显示重复工作区名', () => {
    expect(renderToStaticMarkup(<SessionWorkspaceBadge workspaceName={getSessionWorkspaceBadgeName('工作区A', 'A', 'A')} />)).toBe('')
    expect(renderToStaticMarkup(<SessionWorkspaceBadge workspaceName={getSessionWorkspaceBadgeName('子会话工作区', 'A', 'A')} />)).toBe('')
  })
  test('Given 真实分组helper产出的跨项目自动任务归档组 When 渲染父子来源 Then 不删除A/B身份', () => {
    const workspaces: AgentWorkspace[] = ['A', 'B'].map(id => ({ id, name: `项目${id}`, slug: id, createdAt: 1, updatedAt: 1 }))
    const sessions: AgentSessionMeta[] = ['A', 'B'].map(id => ({ id: `task-${id}`, title: '同名任务', workspaceId: id, archived: true, sourceAutomationId: `auto-${id}`, createdAt: 1, updatedAt: 1 }))
    const groups = groupArchivedAgentSessionsByProject({ sessions, workspaces })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('automation')
    const html = groups[0]!.sessions.map(session => renderToStaticMarkup(<SessionWorkspaceBadge workspaceName={getSessionWorkspaceBadgeName(`项目${session.workspaceId}`, session.workspaceId, groups[0]!.workspace?.id)} />)).join('')
    expect(html).toContain('项目A')
    expect(html).toContain('项目B')
  })
  test('Given 活跃跨项目会话 When 有工作区名 Then 仍保留识别徽标', () => {
    const html = renderToStaticMarkup(<SessionWorkspaceBadge workspaceName="跨项目A" />)
    expect(html).toContain('跨项目A')
    expect(html).toContain('workspace-badge')
    expect(renderToStaticMarkup(<SessionWorkspaceBadge />)).toBe('')
  })
  test('Given 项目普通/归档/重命名分支 When 检查接线 Then 共用状态图标且归档父子携带分组上下文', () => {
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
    expect(source.match(/<SidebarProjectIcon collapsed=\{collapsed\}/g)).toHaveLength(3)
    expect(source).toContain('<SessionWorkspaceBadge workspaceName={workspaceName}')
    expect(source.match(/workspaceName=\{getSessionWorkspaceBadgeName\(/g)).toHaveLength(2)
    expect(source).toContain('LocalProjectBadge')
  })
})
