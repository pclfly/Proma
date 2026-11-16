import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Brain } from 'lucide-react'
import { sessionKnowledgeChangesAtom } from '@/atoms/memory-change-atoms'
import { describeKnowledgeTarget, listSessionKnowledgeChanges } from '@/lib/session-knowledge-changes'

/**
 * 本会话的受限来源 diff。
 *
 * 只展示主进程核验过的 write/edit 提交：不自动打开其它会话、不切换当前焦点，
 * 也不把无来源的文件系统刷新当成 Agent 写入。
 */
export function SessionKnowledgeChanges({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const changesMap = useAtomValue(sessionKnowledgeChangesAtom)
  const changes = listSessionKnowledgeChanges(changesMap, sessionId)
  if (changes.length === 0) return null
  return (
    <div className="mb-2 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/30">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
        <Brain className="size-3.5" />
        <span>本轮记忆/规则更新</span>
        <span className="ml-auto tabular-nums">{changes.length}</span>
      </div>
      <div className="max-h-64 overflow-y-auto border-t border-border/60">
        {changes.map((change) => (
          <div key={change.changeId} className="border-b border-border/40 px-2 py-1.5 last:border-b-0">
            <div className="truncate text-xs font-medium" title={describeKnowledgeTarget(change)}>
              {describeKnowledgeTarget(change)}
            </div>
            <div className="mt-1 space-y-0.5 font-mono text-[11px] leading-4">
              {change.diff.context.map((line, index) => (
                <div key={`c-${index}`} className="truncate text-muted-foreground">{`  ${line}`}</div>
              ))}
              {change.diff.removed.map((line, index) => (
                <div key={`r-${index}`} className="truncate text-destructive">{`- ${line}`}</div>
              ))}
              {change.diff.added.map((line, index) => (
                <div key={`a-${index}`} className="truncate text-emerald-600 dark:text-emerald-400">{`+ ${line}`}</div>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>{change.kind === 'created' ? '新建' : '修改'}</span>
              {change.diff.truncated ? <span>已截断</span> : null}
              <span className="ml-auto">仅本次工具提交</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
