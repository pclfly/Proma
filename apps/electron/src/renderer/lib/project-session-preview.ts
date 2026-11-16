/**
 * 项目会话折叠基线的选择规则。
 *
 * 展开一个项目时先显示「活跃会话 + 最近 N 个会话」，其余才收到「展开其余 N 个会话」里。
 * 之前虚拟侧栏只渲染 1 条会话行，导致项目收起再展开后只剩第一行，需要逐次展开。
 *
 * 输入必须已按活动时间倒序排列（`buildAgentSessionTrees` 的输出满足该前提）。
 */

export interface ProjectSessionPreviewItem {
  session: { id: string }
}

export interface ProjectSessionPreviewSplit<T extends ProjectSessionPreviewItem> {
  /** 折叠基线之外、按最近程度补足的会话 */
  preview: T[]
  /** 需要「展开其余 N 个会话」才能看到的会话 */
  remaining: T[]
}

export function splitProjectSessionPreview<T extends ProjectSessionPreviewItem>(
  treeItems: readonly T[],
  activeIds: ReadonlySet<string>,
  previewLimit: number,
): ProjectSessionPreviewSplit<T> {
  const limit = Math.max(0, Math.trunc(previewLimit))
  const preview: T[] = []
  const remaining: T[] = []

  for (const item of treeItems) {
    if (activeIds.has(item.session.id)) continue
    if (preview.length < limit) preview.push(item)
    else remaining.push(item)
  }

  return { preview, remaining }
}
