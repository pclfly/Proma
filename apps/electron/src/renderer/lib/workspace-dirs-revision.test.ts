import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createWorkspaceDirsRevisions } from './workspace-dirs-revision'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const sidePanel = read('components/agent/SidePanel.tsx')

describe('工作区附加目录列表的代际保护', () => {
  test('Given 同一工作区连续两次请求 When 旧响应后才返回 Then 只接受最新代际', () => {
    const revisions = createWorkspaceDirsRevisions()
    const first = revisions.begin('ws-a')
    const second = revisions.begin('ws-a')
    expect(revisions.isCurrent('ws-a', first)).toBe(false)
    expect(revisions.isCurrent('ws-a', second)).toBe(true)
  })

  test('Given 另一工作区请求 When 本工作区提交 Then 互不影响', () => {
    const revisions = createWorkspaceDirsRevisions()
    const a = revisions.begin('ws-a')
    revisions.begin('ws-b')
    expect(revisions.isCurrent('ws-a', a)).toBe(true)
  })

  test('Given 未发起过请求 When 查询代际 Then 不匹配 0 或任意编号', () => {
    const revisions = createWorkspaceDirsRevisions()
    expect(revisions.isCurrent('ws-none', 0)).toBe(false)
    expect(revisions.isCurrent('ws-none', 1)).toBe(false)
    // 已开始后 0 也不是合法代际（begin 从1开始）。
    revisions.begin('ws-none')
    expect(revisions.isCurrent('ws-none', 0)).toBe(false)
  })

  test('Given picker/拖拽/移除/初读 When 迟到响应 Then SidePanel 统一用代际而非直接写列表', () => {
    // 四条异步路径都先 begin 再经 applyWorkspaceDirs 应用。
    expect(sidePanel).toContain('const revision = beginWorkspaceDirsRequest(workspaceId)')
    expect(sidePanel).toContain('applyWorkspaceDirs(workspaceId, revision, updated)')
    expect(sidePanel).toContain('applyWorkspaceDirs(workspaceId, revision, updated, true)')
    expect(sidePanel).toContain('applyWorkspaceDirs(workspaceId, revision, dirs)')
    // 唯一允许直接写列表的是 applyWorkspaceDirs 自身。
    const directWrites = sidePanel.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('setWsAttachedDirsMap('))
    expect(directWrites).toHaveLength(1)
    expect(sidePanel.split('\n')[directWrites[0]!.index + 1]).toContain('const map = new Map(prev)')
  })
})
