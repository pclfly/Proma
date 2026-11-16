import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionStartup, waitForConnection } from './connection-startup'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('连接启动代际', () => {
  test('Given 新 begin When 旧的尝试检查 Then 旧尝试失效', () => {
    const startup = new ConnectionStartup()
    const first = startup.begin()
    expect(first.isCurrent()).toBe(true)
    const second = startup.begin()
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
    startup.cancel()
    expect(second.isCurrent()).toBe(false)
  })

  test('Given 启动中取消 When wait Then 立即 AbortError', async () => {
    const startup = new ConnectionStartup()
    const attempt = startup.begin()
    const pending = attempt.wait(new Promise<void>(() => {}))
    startup.cancel()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given 操作完成 When wait Then 返回结果并解除监听', async () => {
    const startup = new ConnectionStartup()
    const attempt = startup.begin()
    await expect(attempt.wait(Promise.resolve(42))).resolves.toBe(42)
    expect(attempt.isCurrent()).toBe(true)
  })

  test('Given 旧尝试晚到 When 新 begin Then 结果不能再写状态', async () => {
    const startup = new ConnectionStartup()
    const first = startup.begin()
    const second = startup.begin()
    await sleep(1)
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
  })

  test('Given signal 已取消 When waitForConnection Then 立即拒绝', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForConnection(Promise.resolve(1), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Given Slack/Feishu Bridge When 启动 Then 使用 ConnectionStartup', () => {
    const root = join(import.meta.dir, '..')
    for (const file of ['slack-bridge.ts', 'feishu-bridge.ts']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source).toContain("from './network/connection-startup'")
      expect(source).toContain('new ConnectionStartup()')
      expect(source).toContain('.begin()')
      expect(source).toContain('connectionStartup.cancel()')
    }
  })
})
