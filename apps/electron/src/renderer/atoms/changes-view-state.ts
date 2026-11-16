import { atom } from 'jotai'

export interface ChangesViewState {
  searchQuery: string
  collapsedDirs: Set<string>
  nonGitExpanded: boolean
  earlierExpanded: boolean
  /** 连续改动流总开关（默认展开）。 */
  turnStreamExpanded: boolean
  /** 用户主动展开的时间区间段落 key；默认折叠。 */
  expandedTurnSections: Set<string>
  scrollTop: number
}
export const EMPTY_CHANGES_VIEW: ChangesViewState = {
  searchQuery: '',
  collapsedDirs: new Set(),
  nonGitExpanded: true,
  earlierExpanded: false,
  turnStreamExpanded: true,
  expandedTurnSections: new Set(),
  scrollTop: 0,
}
/** 只保存应用内浏览状态，按会话+工作树+目录范围隔离；有界缓存不增长到所有历史会话。 */
export const changesViewStatesAtom = atom(new Map<string, ChangesViewState>())
export const updateChangesViewAtom = atom(null, (get, set, input: { key: string; patch: Partial<ChangesViewState> }) => {
  const next = new Map(get(changesViewStatesAtom))
  next.delete(input.key)
  next.set(input.key, { ...(get(changesViewStatesAtom).get(input.key) ?? EMPTY_CHANGES_VIEW), ...input.patch })
  while (next.size > 200) next.delete(next.keys().next().value!)
  set(changesViewStatesAtom, next)
})
