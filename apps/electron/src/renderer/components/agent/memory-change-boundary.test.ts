import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// 架构边界回归：raw watcher 没有来源身份，SidePanel 不得订阅它来自动导航。
// 该测试不声称替代完整 Electron/React 视觉验收；可信来源通道有独立行为测试。
describe('记忆刷新与来源会话边界', () => {
  test('Given 无来源文件系统刷新 When SidePanel挂载 Then 不消费工作区共享变化来推测作者', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('workspaceMemoryChangesAtom')
    expect(source).not.toContain('latestMemoryChange.changedAt < runStartedAt')
  })
})
