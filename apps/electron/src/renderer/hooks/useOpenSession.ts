/**
 * useOpenSession — 统一的"打开/聚焦会话 Tab"操作
 *
 * 封装 openTab + setTabs + setActiveTabId + setAppMode + setCurrentXxxId，
 * 确保所有打开会话的入口都能正确同步 appMode 和 currentSessionId。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  openTab,
  buildOpenTabRestore,
  sessionViewStateMapAtom,
  type TabType,
} from '@/atoms/tab-atoms'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { automationFormAtom } from '@/atoms/automation-atoms'

import { currentAgentSessionIdAtom, agentSessionsAtom, currentAgentWorkspaceIdAtom, unviewedCompletedSessionIdsAtom } from '@/atoms/agent-atoms'
import { channelFormDirtyAtom, settingsOpenAtom, settingsPendingSessionNavigationAtom } from '@/atoms/settings-tab'

interface OpenSessionOptions {
  bypassSettingsGuard?: boolean
  /** 仅在导航实际执行后调用；设置 Guard 取消时不会调用。 */
  onOpened?: () => void
}

type OpenSessionFn = (type: TabType, sessionId: string, title: string, options?: OpenSessionOptions) => void

export function useOpenSession(): OpenSessionFn {
  const store = useStore()
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setPendingSessionNavigation = useSetAtom(settingsPendingSessionNavigationAtom)
  // 导航代际：只有最新一次打开的异步回填可以落地。
  const navigationGenerationRef = React.useRef(0)
  const openedWorkspaceIdRef = React.useRef<string | null>(null)

  return React.useCallback(
    (type: TabType, sessionId: string, title: string, options?: OpenSessionOptions): void => {
      if (!options?.bypassSettingsGuard && settingsOpen && channelFormDirty) {
        setPendingSessionNavigation({ type, sessionId, title, onOpened: options?.onOpened })
        return
      }
      setSettingsOpen(false)
      // 每次导航（含命中 active 会话的同步路径）都推进代际，
      // 这样“先发起归档回填、再打开另一会话”也会让旧回填失效。
      const navigationGeneration = ++navigationGenerationRef.current
      openedWorkspaceIdRef.current = store.get(currentAgentWorkspaceIdAtom)

      // 切回 agent 会话时，若该会话上次开着预览 Tab 则一并重建并回到上次视图
      const restore = type === 'agent'
        ? buildOpenTabRestore(
            sessionId,
            store.get(sessionViewStateMapAtom),
            store.get(previewFileMapAtom),
          )
        : undefined
      const result = openTab(tabs, { type, sessionId, title }, restore)
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      setAutomationForm({ open: false, draft: null })
      setActiveView('conversations')

      {
        setAppMode('agent')
        setCurrentAgentSessionId(sessionId)

        // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
        setUnviewedCompleted((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })

        // 同步 workspaceId，确保与 TabBar 切换行为一致。
        // 目标可能不在当前 active 列表（如搜索命中归档会话），此时先按 ID 补齐
        // metadata 再切工作区，不能沿用旧项目的默认值假装已恢复目标。
        const session = agentSessions.find((s) => s.id === sessionId)
        if (session?.workspaceId) {
          setCurrentAgentWorkspaceId(session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
          return
        }
        // 回填必须受导航代际保护：等待期间用户可能已切到另一会话/项目，
        // 迟到的 metadata 不得把 workspace 覆盖回旧目标，更不能写进持久化设置。
        void window.electronAPI.listAgentSessions()
          .then((all) => {
            if (navigationGenerationRef.current !== navigationGeneration) return
            const target = all.find((s) => s.id === sessionId)
            if (!target) return
            // 只 upsert 目标，不把全部归档会话塞回 active 列表。
            store.set(agentSessionsAtom, (prev) => (prev.some((s) => s.id === target.id) ? prev : [target, ...prev]))
            if (!target.workspaceId) return
            // 打开期间用户已切走会话或切了项目，则只补 metadata 不动当前工作区。
            if (store.get(currentAgentSessionIdAtom) !== sessionId) return
            const currentWorkspaceId = store.get(currentAgentWorkspaceIdAtom)
            const workspaceChangedSinceOpen = openedWorkspaceIdRef.current !== currentWorkspaceId
            if (workspaceChangedSinceOpen) return
            setCurrentAgentWorkspaceId(target.workspaceId)
            window.electronAPI.updateSettings({ agentWorkspaceId: target.workspaceId }).catch(console.error)
          })
          .catch(console.error)
      }

      options?.onOpened?.()
    },
    [tabs, setTabs, setActiveTabId, setAutomationForm, setActiveView, setAppMode, setCurrentAgentSessionId, agentSessions, setCurrentAgentWorkspaceId, setUnviewedCompleted, settingsOpen, channelFormDirty, setSettingsOpen, setPendingSessionNavigation, currentAgentSessionId, store],
  )
}
