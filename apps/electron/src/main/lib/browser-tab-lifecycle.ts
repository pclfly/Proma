/**
 * 浏览器标签生命周期策略。
 *
 * 官方 0.22.0：把“草稿标签回收、超限回收、预览标签复用”从 controller 中抽出，
 * 便于单测。`retained` 表示用户标签（不可自动回收）。
 */

export interface BrowserTabLifecycleInfo {
  tabId: string
  retained: boolean
  lastActivityAt: number
  localPreviewPath?: string | null
}

/** 草稿标签：非 retained 且不是 Agent 当前工作标签，可全部回收。 */
export function selectDraftTabsToReclaim(
  tabs: readonly BrowserTabLifecycleInfo[],
  agentTabId: string | null,
): string[] {
  return tabs
    .filter((tab) => !tab.retained && tab.tabId !== agentTabId)
    .map((tab) => tab.tabId)
}

/** 超过 maxTabs 时，按最久未使用回收非 retained 标签；保留 active/agent 标签。 */
export function selectExcessTabsToReclaim(
  tabs: readonly BrowserTabLifecycleInfo[],
  options: { maxTabs: number; activeTabId: string; agentTabId: string | null },
): string[] {
  const excess = tabs.length - options.maxTabs
  if (excess <= 0) return []
  return tabs
    .filter((tab) => !tab.retained && tab.tabId !== options.activeTabId && tab.tabId !== options.agentTabId)
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    .slice(0, excess)
    .map((tab) => tab.tabId)
}

/** 同一文件的本地预览标签可复用；优先 Agent 当前标签。 */
export function findReusablePreviewTab(
  tabs: readonly BrowserTabLifecycleInfo[],
  filePath: string,
  agentTabId: string | null,
): string | null {
  const matches = tabs.filter((tab) => tab.localPreviewPath === filePath)
  return (matches.find((tab) => tab.tabId === agentTabId) ?? matches[0])?.tabId ?? null
}
