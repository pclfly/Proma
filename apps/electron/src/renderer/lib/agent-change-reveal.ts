/**
 * 官方 0.22.0：任务结束后，当前会话存在未查看改动时自动展开右侧改动区。
 *
 * 只看用户正在查看的顶层会话；后台任务、未聚焦窗口和其它会话都不抢焦点。
 *
 * 2026-11-13 调整：右侧工作区已经打开时不再把 Tab 抢到「改动」。之前每到一轮结束就
 * 切走用户正在看的文件/预览/Tab，连续对话时几乎每轮都被打断；已打开时只保留未查看
 * 标记（改动 Tab 上的圆点），仅在右侧收起时才自动展开到改动，兼顾发现性与不抢焦点。
 */

export interface AutoRevealChangesInput {
  /** 当前激活的 Agent 会话。 */
  currentSessionId: string | null
  /** 刚结束的会话。 */
  sessionId: string
  /** 是否仍有后台任务在跑（此时不打断当前视图）。 */
  backgroundTasksPending: boolean
  /** 主窗口是否聚焦；后台窗口只标记未读。 */
  documentHasFocus: boolean
  /** 是否存在未查看的改动。 */
  hasUnseenChanges: boolean
  /** 是否存在非 Git 文件改动。 */
  hasNonGitChanges: boolean
  /** 该会话的右侧工作区是否已经打开；已打开时尊重用户当前的 Tab 选择。 */
  sidePanelOpen: boolean
}

export function shouldAutoRevealChanges(_input: AutoRevealChangesInput): boolean {
  // 官方 0.22.80：Agent 标记知识更新或文件改动时不再自行打开右侧工作区。
  // 阅读中的预览、终端或另一处改动都可能被打断，因此一律只保留未查看标记；
  // 用户点击改动/交付物入口时再打开。保留入参结构，便于未读逻辑继续复用同一判据。
  return false
}
