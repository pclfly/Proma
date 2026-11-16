import * as React from 'react'
import { useSetAtom } from 'jotai'
import { workspaceKnowledgeAccessAtom, workspaceMemoryChangesAtom } from '@/atoms/memory-change-atoms'

/** Keeps the selected workspace observed even while its right file panel is closed. */
export function WorkspaceMemoryChangeObserver({ workspaceSlug }: { workspaceSlug: string }): null {
  const setUpdatesByWorkspace = useSetAtom(workspaceMemoryChangesAtom)
  const setAccessByWorkspace = useSetAtom(workspaceKnowledgeAccessAtom)

  React.useEffect(() => {
    return window.electronAPI.subscribeWorkspaceMemoryChanges(workspaceSlug, (change) => {
      if (change.accessChanged) {
        // 撤销/改向后旧正文 diff 已不属于当前权限：整体清空该工作区变更提示，只推进授权代际。
        setUpdatesByWorkspace((previous) => {
          if (!previous.has(workspaceSlug)) return previous
          const next = new Map(previous)
          next.delete(workspaceSlug)
          return next
        })
        setAccessByWorkspace((previous) => {
          const next = new Map(previous)
          next.set(workspaceSlug, (previous.get(workspaceSlug) ?? 0) + 1)
          return next
        })
        return
      }
      setUpdatesByWorkspace((previous) => {
        const next = new Map(previous)
        const existing = next.get(workspaceSlug) ?? []
        next.set(workspaceSlug, [
          change,
          ...existing.filter((item) => item.relativePath !== change.relativePath),
        ].slice(0, 8))
        return next
      })
    })
  }, [setAccessByWorkspace, setUpdatesByWorkspace, workspaceSlug])

  return null
}
