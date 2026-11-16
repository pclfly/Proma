/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏视图模式 */
/**
 * 侧边栏视图模式。
 * - active：未归档会话
 * - archived：已归档会话
 * - starred：收藏会话（星标），独立于归档状态，供「收藏」入口恢复
 */
export type SidebarViewMode = 'active' | 'archived' | 'starred'

/**
 * 三种入口各自独立记忆：切到收藏再回到活跃，不会把归档列表带回来。
 * localStorage 持久化失败时退回默认值，不影响功能。
 */
const VIEW_MODE_STORAGE_KEY = 'proma:sidebar-view-mode'
const VIEW_MODES: readonly SidebarViewMode[] = ['active', 'archived', 'starred']

function readPersistedViewMode(): SidebarViewMode {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY)
    return VIEW_MODES.includes(raw as SidebarViewMode) ? raw as SidebarViewMode : 'active'
  } catch {
    return 'active'
  }
}

export const sidebarViewModeAtom = atom<SidebarViewMode>(readPersistedViewMode())

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'proma-workspace-list-height',
  120,
)

/** 左侧边栏宽度（px），用户可拖拽调整，持久化到 localStorage */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'proma-left-sidebar-width',
  // 官方 0.22.0 分区侧栏默认 300px。
  300,
)

/**
 * 项目会话折叠状态提升到全局 atom：切换清单/日程/收藏等页面时 LeftSidebar 会卸载，
 * 组件内 state 会丢失并重新触发“默认全折叠”，导致返回首页后所有项目又收起。
 */
export const collapsedWorkspaceIdsAtom = atom<Set<string>>(new Set<string>())

/** 默认折叠只在本次 renderer 生命周期执行一次，不随侧栏重新挂载重复。 */
export const workspaceCollapseInitializedAtom = atom(false)

/** 由订阅方在变化时调用；单独函数便于测试且不把副作用塞进 atom。 */
export function persistSidebarViewMode(mode: SidebarViewMode): void {
  try {
    globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // 隐私模式或配额耗尽：只在本次会话内生效。
  }
}
