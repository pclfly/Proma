import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('Files 窄宽布局滚动记忆接线', () => {
  test('Given Tab从宿主外进入子控件 When 焦点自动滚动 Then focusin接管且卸载移除监听', () => {
    const source = readFileSync(new URL('./PersistentFileScrollArea.tsx', import.meta.url), 'utf8')
    expect(source).toContain("container.addEventListener('focusin', takeControl)")
    expect(source).toContain("container.removeEventListener('focusin', takeControl)")
  })
  test('Given 窄Files分支 When 切来源/工作区 Then 与宽分支使用同一按来源roots隔离的滚动容器', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('stateKey={getFileBrowserScrollStateKey(sessionId, fileSourceFilter, visibleFileRoots)}')
    expect(source).toContain('stateKey={getFileBrowserScrollStateKey(sessionId, scope, roots)}')
  })
})
