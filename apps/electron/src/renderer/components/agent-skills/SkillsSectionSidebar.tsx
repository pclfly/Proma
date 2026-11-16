/**
 * Skills/MCP 分区侧栏（官方 0.22.0 左侧第二列）。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { LayoutGrid, Workflow } from 'lucide-react'
import { agentSkillsSectionCountsAtom, agentSkillsTabAtom } from '@/atoms/active-view'
import { cn } from '@/lib/utils'

const ITEMS = [
  { id: 'skills' as const, label: 'Skills', icon: <LayoutGrid size={15} /> },
  { id: 'mcp' as const, label: 'MCP', icon: <Workflow size={15} /> },
]

export function SkillsSectionSidebar(): React.ReactElement {
  const [tab, setTab] = useAtom(agentSkillsTabAtom)
  const counts = useAtomValue(agentSkillsSectionCountsAtom)

  return (
    <nav className="space-y-1 p-2" aria-label="Skills 与 MCP">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setTab(item.id)}
          aria-pressed={tab === item.id}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors',
            tab === item.id
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <span className="text-muted-foreground">{item.icon}</span>
          <span className="flex-1 text-left">{item.label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {item.id === 'skills' ? counts.skills : counts.mcp}
          </span>
        </button>
      ))}
    </nav>
  )
}
