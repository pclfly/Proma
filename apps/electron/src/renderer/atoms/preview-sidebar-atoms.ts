import { atom } from 'jotai'
import { appModeAtom } from './app-mode'
import { activeViewAtom } from './active-view'
import { automationFormAtom } from './automation-atoms'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, agentSidePanelSplitMapAtom, currentAgentSessionIdAtom, getPreviewIdFromSidePanelTab } from './agent-atoms'
import type { AgentSidePanelTab } from './agent-atoms'
import { getPreviewFileId, previewFilesMapAtom, previewSidebarEpisodesAtom } from './preview-atoms'
import { sidebarCollapsedAtom } from './tab-atoms'

/** 与AppShell实际右栏可见条件一致；切到Chat/全屏工具/其它会话不借用旧预览状态。 */
const activePreviewSidebarEpisodeAtom = atom((get) => {
  if (get(appModeAtom) !== 'agent') return null
  const view = get(activeViewAtom)
  if (view === 'planning' || view === 'agent-skills' || (get(automationFormAtom).open && view !== 'conversations')) return null
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId || !get(agentSidePanelOpenAtomFamily(sessionId))) return null
  const files = get(previewFilesMapAtom).get(sessionId) ?? []
  const isVisiblePreview = (tab: AgentSidePanelTab | 'preview' | 'browser' | undefined): boolean => {
    if (tab === 'preview') return files.length > 0
    const previewId = tab && tab !== 'browser' ? getPreviewIdFromSidePanelTab(tab) : null
    return previewId !== null && files.some((file) => getPreviewFileId(file) === previewId)
  }
  const split = get(agentSidePanelSplitMapAtom).get(sessionId)
  // 按实际Pane可见性判断，而非旧open标志：快捷键隐藏后恢复，直接点Tab也可重新让位。
  const visible = split
    ? isVisiblePreview(split.leftTab) || isVisiblePreview(split.rightTab)
    : isVisiblePreview(get(agentDiffPanelTabAtom).get(sessionId))
  return visible ? get(previewSidebarEpisodesAtom).get(sessionId) ?? null : null
})

/** 自动让位只是投影；只有显式按钮、快捷键或拖拽才写用户持久偏好。 */
export const effectiveSidebarCollapsedAtom = atom(
  (get) => {
    const episode = get(activePreviewSidebarEpisodeAtom)
    return episode ? (get(episode) ?? true) : get(sidebarCollapsedAtom)
  },
  (get, set, update: boolean | ((previous: boolean) => boolean)) => {
    const value = typeof update === 'function' ? update(get(effectiveSidebarCollapsedAtom)) : update
    const episode = get(activePreviewSidebarEpisodeAtom)
    if (episode) set(episode, value)
    set(sidebarCollapsedAtom, value)
  },
)
