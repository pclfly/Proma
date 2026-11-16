import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentTurnUsageReader } from './agent-turn-usage-service'

describe('Agent turn usage 汇总', () => {
  test('Given 同会话并发查询 When 读取 Then 只解析一次并共享结果', async () => {
    let loads = 0
    const reader = createAgentTurnUsageReader(() => {
      loads += 1
      return 0.42
    })
    const [a, b] = await Promise.all([reader.get('session-1'), reader.get('session-1')])
    expect(a).toBe(0.42)
    expect(b).toBe(0.42)
    expect(loads).toBe(1)
    expect(await reader.get('session-1')).toBe(0.42)
    expect(loads).toBe(1)
  })

  test('Given 未知占用率 When 重复读取 Then 不缓存 undefined', async () => {
    let loads = 0
    const reader = createAgentTurnUsageReader(() => {
      loads += 1
      return undefined
    })
    expect(await reader.get('session-1')).toBeUndefined()
    expect(await reader.get('session-1')).toBeUndefined()
    expect(loads).toBe(2)
  })

  test('Given clear When 再次读取 Then 重新解析', async () => {
    let loads = 0
    const reader = createAgentTurnUsageReader(() => {
      loads += 1
      return 0.1
    })
    await reader.get('session-1')
    reader.clear()
    await reader.get('session-1')
    expect(loads).toBe(2)
  })

  test('Given automation 汇总入口 When 读取占用率 Then 使用缓存服务', () => {
    const source = readFileSync(join(import.meta.dir, 'automation-scheduler.ts'), 'utf8')
    expect(source).toContain("from './agent-turn-usage-service'")
    expect(source).toContain('await getAgentTurnUsage(automation.lastSessionId)')
    expect(source).not.toContain('getSessionContextUsageRatio(')
  })
})
