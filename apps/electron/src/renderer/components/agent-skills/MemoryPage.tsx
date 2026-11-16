/**
 * Memory 页面：官方 0.22.0 的「关于你 / 当前项目」双入口。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { GlobalProfilePanel } from './GlobalProfilePanel'
import { WorkspaceMemoryTab } from './WorkspaceMemoryTab'

type MemoryScope = 'global' | 'project'

export function MemoryPage({
  workspaceSlug,
  search,
}: {
  workspaceSlug: string
  search?: string
}): React.ReactElement {
  const [scope, setScope] = React.useState<MemoryScope>('global')

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex shrink-0 items-center gap-1 rounded-xl bg-muted/45 p-1">
        <button
          type="button"
          onClick={() => setScope('global')}
          className={cn(
            'flex h-10 min-w-[9rem] items-center justify-center rounded-lg px-6 text-sm font-medium transition-colors',
            scope === 'global' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={scope === 'global'}
        >
          关于你
        </button>
        <button
          type="button"
          onClick={() => setScope('project')}
          className={cn(
            'flex h-10 min-w-[9rem] items-center justify-center rounded-lg px-6 text-sm font-medium transition-colors',
            scope === 'project' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={scope === 'project'}
        >
          当前项目
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {scope === 'global'
          ? <GlobalProfilePanel />
          : <WorkspaceMemoryTab workspaceSlug={workspaceSlug} search={search} />}
      </div>
    </div>
  )
}
