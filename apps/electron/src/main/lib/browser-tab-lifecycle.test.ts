import { describe, expect, test } from 'bun:test'
import {
  findReusablePreviewTab,
  selectDraftTabsToReclaim,
  selectExcessTabsToReclaim,
  type BrowserTabLifecycleInfo,
} from './browser-tab-lifecycle'

const tab = (tabId: string, retained: boolean, lastActivityAt: number, localPreviewPath?: string): BrowserTabLifecycleInfo => ({
  tabId,
  retained,
  lastActivityAt,
  ...(localPreviewPath ? { localPreviewPath } : {}),
})

describe('浏览器标签生命周期', () => {
  test('Given 草稿与非 Agent 标签 When 选择回收 Then 只返回可回收 ID', () => {
    const tabs = [tab('agent', false, 1), tab('draft', false, 2), tab('user', true, 3)]
    expect(selectDraftTabsToReclaim(tabs, 'agent')).toEqual(['draft'])
  })

  test('Given 超过上限 When 选择回收 Then 按最久未使用且保留 active/agent/user', () => {
    const tabs = [
      tab('user', true, 1),
      tab('active', false, 2),
      tab('agent', false, 3),
      tab('old', false, 4),
      tab('new', false, 5),
    ]
    expect(selectExcessTabsToReclaim(tabs, { maxTabs: 3, activeTabId: 'active', agentTabId: 'agent' }))
      .toEqual(['old', 'new'])
  })

  test('Given 未超过上限 When 选择回收 Then 返回空', () => {
    expect(selectExcessTabsToReclaim([tab('a', false, 1)], { maxTabs: 3, activeTabId: 'a', agentTabId: null }))
      .toEqual([])
  })

  test('Given 同一文件预览 When 查找复用 Then 优先 agent 标签', () => {
    const tabs = [
      tab('first', true, 1, '/a.md'),
      tab('agent', false, 2, '/a.md'),
      tab('other', false, 3, '/b.md'),
    ]
    expect(findReusablePreviewTab(tabs, '/a.md', 'agent')).toBe('agent')
    expect(findReusablePreviewTab(tabs, '/a.md', null)).toBe('first')
    expect(findReusablePreviewTab(tabs, '/missing.md', null)).toBeNull()
  })
})
