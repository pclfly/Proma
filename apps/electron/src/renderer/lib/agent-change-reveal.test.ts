import { describe, expect, test } from 'bun:test'
import { shouldAutoRevealChanges } from './agent-change-reveal'

const base = {
  currentSessionId: 'session-1',
  sessionId: 'session-1',
  backgroundTasksPending: false,
  documentHasFocus: true,
  hasUnseenChanges: true,
  hasNonGitChanges: false,
  sidePanelOpen: false,
}

describe('任务结束后的改动入口（0.22.80）', () => {
  test('Given 当前会话结束、右侧收起且有未查看改动 When 判定 Then 不自动展开', () => {
    // 官方 0.22.80 改为只标记未读；自动展开会抢走用户正在阅读的预览或终端。
    expect(shouldAutoRevealChanges(base)).toBe(false)
  })

  test('Given 只有非 Git 改动 When 判定 Then 同样不自动展开', () => {
    expect(shouldAutoRevealChanges({
      ...base,
      hasUnseenChanges: false,
      hasNonGitChanges: true,
    })).toBe(false)
  })

  test('Given 右侧已打开且用户在看别的 Tab When 判定 Then 不抢焦点', () => {
    expect(shouldAutoRevealChanges({ ...base, sidePanelOpen: true })).toBe(false)
  })

  test('Given 窗口未聚焦或后台任务仍在运行 When 判定 Then 不展开', () => {
    expect(shouldAutoRevealChanges({ ...base, documentHasFocus: false })).toBe(false)
    expect(shouldAutoRevealChanges({ ...base, backgroundTasksPending: true })).toBe(false)
  })
})
