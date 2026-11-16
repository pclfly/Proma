import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'

const read = (relativePath: string): string =>
  readFileSync(join(import.meta.dir, relativePath), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('停止策略', () => {
  test('Given 启动中或队列派发中 When 停止 Then 要求在 run 前记住停止', () => {
    expect(shouldStopBeforeAgentRun(true, false)).toBe(true)
    expect(shouldStopBeforeAgentRun(false, true)).toBe(true)
    expect(shouldStopBeforeAgentRun(false, false)).toBe(false)
  })

  test('Given stopAgent When 调用 Then 用策略判断是否暂停队列且不污染后继轮', () => {
    const source = read('agent-service.ts')
    expect(source).toContain("import { shouldStopBeforeAgentRun } from './agent-stop-policy'")
    expect(source).toContain('shouldStopBeforeAgentRun(')
    expect(source).toContain('if (run || stopBeforeRun) agentQueueCoordinator.pauseForStop(sessionId)')
    expect(source).toContain('orchestrator.stop(sessionId)')
    expect(source).not.toContain('orchestrator.stop(sessionId, stopBeforeRun)')
  })
})

describe('文件改动 diff 接线', () => {
  test('Given 记忆变更监听 When 生成 diff Then 复用 file-change-diff', () => {
    const source = read('workspace-memory-change-watcher.ts')
    expect(source).toContain("import { createFileChange } from './file-change-diff'")
    expect(source).toContain('createFileChange(relativePath, before, after, changedAt)')
    expect(source).not.toContain("from './line-diff'")
  })
})

describe('安装包下载接线', () => {
  test('Given installer-downloader When 下载 Then 使用系统网络 fetch 与 writeDownloadBody', () => {
    const source = read('installer-downloader.ts')
    expect(source).toContain("from './network/host-system-fetch'")
    expect(source).toContain('createHostSystemFetch(\'download\')')
    expect(source).toContain("from './network/download-body'")
    expect(source).toContain('writeDownloadBody(')
    expect(source).not.toContain("from 'http'")
    expect(source).not.toContain("from 'https'")
  })
})
