import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { appModeAtom } from './app-mode'
import { activeViewAtom } from './active-view'
import { agentSidePanelOpenAtomFamily, currentAgentSessionIdAtom, agentSidePanelSplitMapAtom, getPreviewSidePanelTab, agentDiffPanelTabAtom } from './agent-atoms'
import { sidebarCollapsedAtom, tabsAtom, activeTabIdAtom, createPreviewTabId } from './tab-atoms'
import { previewFilesMapAtom, previewFileMapAtom, previewPanelOpenMapAtom, getPreviewFileId, type PreviewFile } from './preview-atoms'
import { effectiveSidebarCollapsedAtom } from './preview-sidebar-atoms'
import { openPreviewInStore, tearOffPreviewToSplit } from '../components/diff/preview-opener'

const a: PreviewFile = { filePath: '/fixture/a.md', previewOnly: true }
const b: PreviewFile = { filePath: '/fixture/b.md', previewOnly: true }
function fixture(collapsed = false) {
  const store = createStore()
  store.set(appModeAtom, 'agent'); store.set(currentAgentSessionIdAtom, 'A')
  store.set(sidebarCollapsedAtom, collapsed); store.set(agentSidePanelOpenAtomFamily('A'), true)
  store.set(agentDiffPanelTabAtom, new Map([['A', 'preview'], ['B', 'preview']]))
  const files = (id: string, next: PreviewFile[]) => store.set(previewFilesMapAtom, (prev) => new Map(prev).set(id, next))
  const effective = () => store.get(effectiveSidebarCollapsedAtom)
  return { store, files, effective }
}
describe('预览临时让位与用户侧栏偏好', () => {
  test('Given 真实预览快捷键隐藏路径 When 切files且保留文件 Then 恢复左栏并允许Tab直接重开', () => {
    const f = fixture(); openPreviewInStore(f.store, 'A', a)
    f.store.set(previewPanelOpenMapAtom, new Map([['A', false]])); f.store.set(agentDiffPanelTabAtom, new Map([['A', 'files']]))
    expect(f.effective()).toBe(false)
    f.store.set(agentDiffPanelTabAtom, new Map([['A', getPreviewSidePanelTab(getPreviewFileId(a))]])); expect(f.effective()).toBe(true)
    f.store.set(effectiveSidebarCollapsedAtom, false)
    f.store.set(agentDiffPanelTabAtom, new Map([['A', 'files']])); f.store.set(agentDiffPanelTabAtom, new Map([['A', getPreviewSidePanelTab(getPreviewFileId(a))]]))
    expect(f.effective()).toBe(false)
  })
  test('Given 预览已被快捷键隐藏 When 分屏仍展示预览Pane Then 按实际可见Pane让位而非旧open标志', () => {
    const f = fixture(); openPreviewInStore(f.store, 'A', a)
    f.store.set(previewPanelOpenMapAtom, new Map([['A', false]])); f.store.set(agentDiffPanelTabAtom, new Map([['A', 'files']]))
    const preview = getPreviewSidePanelTab(getPreviewFileId(a))
    f.store.set(agentSidePanelSplitMapAtom, new Map([['A', { leftTab: 'files', rightTab: preview, focusedPane: 'left', ratio: 0.5 }]]))
    expect(f.effective()).toBe(true)
    f.store.set(agentSidePanelSplitMapAtom, new Map([['A', { leftTab: 'files', rightTab: 'changes', focusedPane: 'right', ratio: 0.5 }]]))
    expect(f.effective()).toBe(false)
    f.store.set(agentSidePanelSplitMapAtom, new Map()); expect(f.effective()).toBe(false)
  })
  test('Given 旧单文件投影没有新列表 When 真实迁移入口调用 Then 归一化列表并建立让位生命周期', () => {
    const f = fixture(); const id = createPreviewTabId('A')
    f.store.set(tabsAtom, [{ id: 'A', sessionId: 'A', type: 'agent', title: 'A' }, { id, sessionId: 'A', type: 'preview', title: 'preview' }])
    f.store.set(activeTabIdAtom, id); f.store.set(previewFileMapAtom, new Map([['A', a]])); f.store.set(previewPanelOpenMapAtom, new Map([['A', true]]))
    tearOffPreviewToSplit(f.store, id)
    expect(f.store.get(previewFilesMapAtom).get('A')).toEqual([a]); expect(f.effective()).toBe(true)
    expect(f.store.get(tabsAtom).some((tab) => tab.type === 'preview')).toBe(false); expect(f.store.get(activeTabIdAtom)).toBe('A')
  })
  test('Given 真实统一预览入口 When 重复打开同一文件及更新权限 Then 不重置手动展开', () => {
    const f = fixture(); openPreviewInStore(f.store, 'A', a); expect(f.effective()).toBe(true)
    f.store.set(effectiveSidebarCollapsedAtom, false); openPreviewInStore(f.store, 'A', { ...a, readOnly: true })
    expect(f.effective()).toBe(false); expect(f.store.get(previewFilesMapAtom).get('A')).toEqual([{ ...a, readOnly: true }])
    f.files('A', []); openPreviewInStore(f.store, 'A', a); expect(f.effective()).toBe(true)
  })
  test('Given 展开的左栏 When 首开预览 Then 临时折叠且不改持久偏好', () => {
    const f = fixture(); f.files('A', [a]); expect(f.effective()).toBe(true); expect(f.store.get(sidebarCollapsedAtom)).toBe(false)
    f.files('A', []); expect(f.effective()).toBe(false)
  })
  test('Given 原来已折叠 When 预览关闭 Then 不强制展开', () => {
    const f = fixture(true); f.files('A', [a]); f.files('A', []); expect(f.effective()).toBe(true)
  })
  test('Given 两个预览 When 只关一个 Then 不提前恢复且最后关闭才恢复', () => {
    const f = fixture(); f.files('A', [a, b]); f.files('A', [b]); expect(f.effective()).toBe(true)
    f.files('A', []); expect(f.effective()).toBe(false)
  })
  test('Given A预览打开 When 切到无预览B Then 不借用A的收栏且切回A仍让位', () => {
    // Chat 模式入口已移除，原“切到 Chat 恢复”场景不再存在；此处只保留会话隔离。
    const f = fixture(); f.files('A', [a]); f.store.set(currentAgentSessionIdAtom, 'B'); f.store.set(agentSidePanelOpenAtomFamily('B'), true)
    expect(f.effective()).toBe(false); f.store.set(currentAgentSessionIdAtom, 'A'); expect(f.effective()).toBe(true)
  })
  test('Given 预览文件保留 When 隐藏右栏或打开全屏工具 Then 恢复用户偏好', () => {
    const f = fixture(); f.files('A', [a]); f.store.set(agentSidePanelOpenAtomFamily('A'), false); expect(f.effective()).toBe(false)
    f.store.set(agentSidePanelOpenAtomFamily('A'), true); expect(f.effective()).toBe(true)
    f.store.set(activeViewAtom, 'planning'); expect(f.effective()).toBe(false)
    f.store.set(activeViewAtom, 'agent-skills'); expect(f.effective()).toBe(false)
    f.store.set(activeViewAtom, 'conversations'); expect(f.effective()).toBe(true)
  })
  test('Given 临时折叠 When 用户展开 Then 同一预览生命周期不再强制收起', () => {
    const f = fixture(); f.files('A', [a]); f.store.set(effectiveSidebarCollapsedAtom, false)
    expect(f.effective()).toBe(false); expect(f.store.get(sidebarCollapsedAtom)).toBe(false)
    f.files('A', [a, b]); f.files('A', [b]); expect(f.effective()).toBe(false)
    f.store.set(currentAgentSessionIdAtom, 'B'); f.store.set(currentAgentSessionIdAtom, 'A'); expect(f.effective()).toBe(false)
    f.files('A', []); f.files('A', [a]); expect(f.effective()).toBe(true)
  })
  test('Given 用户主动折叠 When 关闭预览 Then 保留显式持久选择', () => {
    const f = fixture(); f.files('A', [a]); f.store.set(effectiveSidebarCollapsedAtom, false)
    f.store.set(effectiveSidebarCollapsedAtom, (previous) => !previous); f.files('A', [])
    expect(f.effective()).toBe(true); expect(f.store.get(sidebarCollapsedAtom)).toBe(true)
  })
  test('Given 分屏中存在预览 When 切换焦点或关闭另一Pane Then 预览仍让位', () => {
    const f = fixture(); f.files('A', [a]); f.store.set(agentSidePanelSplitMapAtom, new Map([['A', { leftTab: 'files', rightTab: getPreviewSidePanelTab(getPreviewFileId(a)), focusedPane: 'left', ratio: 0.5 }]]))
    expect(f.effective()).toBe(true); f.store.set(agentSidePanelSplitMapAtom, new Map()); expect(f.effective()).toBe(true)
    f.files('A', []); expect(f.effective()).toBe(false)
  })
  test('Given 不同会话的手动覆盖 When 关闭或删除A文件map条目 Then 不污染B生命周期', () => {
    const f = fixture(); f.files('A', [a]); f.store.set(effectiveSidebarCollapsedAtom, false)
    f.files('B', [b]); f.store.set(agentSidePanelOpenAtomFamily('B'), true); f.store.set(currentAgentSessionIdAtom, 'B'); expect(f.effective()).toBe(true)
    f.store.set(previewFilesMapAtom, (prev) => { const next = new Map(prev); next.delete('A'); return next })
    expect(f.effective()).toBe(true); f.store.set(previewFilesMapAtom, new Map()); expect(f.effective()).toBe(false)
  })
  test('Given 不同Jotai store When A让位 Then 独立窗口/store不共享运行期override', () => {
    const f = fixture(); const other = fixture(); f.files('A', [a]); expect(f.effective()).toBe(true); expect(other.effective()).toBe(false)
  })
})
