import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..', '..')
const appRoot = join(rendererRoot, '..', '..')
const read = (relativePath: string): string =>
  readFileSync(join(rendererRoot, relativePath), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('Memory renderer 入口', () => {
  test('Given Memory 页 When 渲染 Then 提供关于你/当前项目双入口', () => {
    const page = read('components/agent-skills/MemoryPage.tsx')
    expect(page).toContain('关于你')
    expect(page).toContain('当前项目')
    expect(page).toContain('<GlobalProfilePanel />')
    expect(page).toContain('<WorkspaceMemoryTab')
    const view = read('components/agent-skills/AgentSkillsView.tsx')
    expect(view).toContain("import { MemoryPage } from './MemoryPage'")
    expect(view).toContain('<MemoryPage workspaceSlug={data.workspaceSlug} search={search} />')
  })

  test('Given 关于你 When 操作 Then 消费画像读取/保存/历史/恢复接口', () => {
    const panel = read('components/agent-skills/GlobalProfilePanel.tsx')
    expect(panel).toContain('readGlobalProfile()')
    expect(panel).toContain('writeGlobalProfile(profile.revision, text)')
    expect(panel).toContain('readGlobalProfileHistory(8)')
    expect(panel).toContain('readGlobalProfileHistoryVersion(entry.revision)')
    expect(panel).toContain('restoreGlobalProfileHistory(')
  })

  test('Given preload 与主进程 When 接线 Then 暴露同一组全局画像 IPC', () => {
    const preload = readFileSync(join(appRoot, 'src', 'preload', 'index.ts'), 'utf8')
    const ipc = readFileSync(join(appRoot, 'src', 'main', 'ipc.ts'), 'utf8')
    for (const channel of [
      'READ_GLOBAL_PROFILE',
      'WRITE_GLOBAL_PROFILE',
      'READ_GLOBAL_PROFILE_HISTORY',
      'READ_GLOBAL_PROFILE_HISTORY_VERSION',
      'RESTORE_GLOBAL_PROFILE_HISTORY',
    ]) {
      expect(preload).toContain(`AGENT_IPC_CHANNELS.${channel}`)
      expect(ipc).toContain(`AGENT_IPC_CHANNELS.${channel}`)
    }
  })
})
