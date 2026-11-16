/**
 * 定时任务列表的纯函数工具（项目分组 / 运行状态判断）
 */

import type { Automation } from '@proma/shared'

/** 未关联项目的工作区分组标题 */
export const UNASSIGNED_WORKSPACE_LABEL = '未分配项目'

/** 已关联但工作区已被删除时的分组标题 */
export const UNKNOWN_WORKSPACE_LABEL = '未知项目'

export interface AutomationWorkspaceGroup {
  /** 空字符串表示未分配项目 */
  workspaceId: string
  name: string
  automations: Automation[]
  /** 组内是否有正在执行的运行（用于默认展开运行记录） */
  hasRunningRun: boolean
}

/** 任务是否有一轮正在执行 */
export function hasRunningAutomationRun(automation: Automation): boolean {
  return (automation.runHistory ?? []).some((run) => run.status === 'running')
}

/**
 * 按 workspaceId 分组并排序：
 * - 已关联项目按项目名排序（zh-CN）
 * - 未分配项目固定排在最后
 */
export function groupAutomationsByWorkspace(
  automations: Automation[],
  workspaceNames: ReadonlyMap<string, string>,
  compare: (a: Automation, b: Automation) => number,
): AutomationWorkspaceGroup[] {
  const buckets = new Map<string, Automation[]>()
  for (const automation of automations) {
    const workspaceId = automation.workspaceId ?? ''
    const bucket = buckets.get(workspaceId)
    if (bucket) bucket.push(automation)
    else buckets.set(workspaceId, [automation])
  }

  const groups: AutomationWorkspaceGroup[] = []
  for (const [workspaceId, items] of buckets) {
    groups.push({
      workspaceId,
      name: workspaceId
        ? workspaceNames.get(workspaceId) ?? UNKNOWN_WORKSPACE_LABEL
        : UNASSIGNED_WORKSPACE_LABEL,
      automations: [...items].sort(compare),
      hasRunningRun: items.some(hasRunningAutomationRun),
    })
  }

  return groups.sort((a, b) => {
    if (!a.workspaceId && b.workspaceId) return 1
    if (a.workspaceId && !b.workspaceId) return -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}
