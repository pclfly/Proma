import { describe, expect, test } from 'bun:test'
import { AgentStreamRouteRegistry } from './agent-stream-route-registry'

describe('Agent 流路由运行所有权', () => {
  test('Given headless无目标启动 When 主窗恢复 Then 补目标但保持原owner完成与清理', () => {
    const routes = new AgentStreamRouteRegistry<{ isDestroyed(): boolean }>()
    const run = routes.bind('s', null)
    expect(routes.get('s')).toBeUndefined()
    expect(routes.sessionIds()).toEqual(['s'])
    const target = { isDestroyed: () => false }
    expect(routes.rebind('s', target).ownerId).toBe(run.ownerId)
    expect(routes.getTargetIfOwner('s', run.ownerId)).toBe(target)
    expect(routes.removeIfOwner('s', run.ownerId)).toBe(true)
    expect(routes.sessionIds()).toEqual([])
  })
  test('Given 旧owner迟到清理与销毁的renderer When 新run已取得owner Then 不删新run且不投递到销毁目标', () => {
    let destroyed = false
    const target = { isDestroyed: () => destroyed }
    const routes = new AgentStreamRouteRegistry<typeof target>()
    const old = routes.bind('s', target)
    const current = routes.bind('s', target)
    expect(routes.removeIfOwner('s', old.ownerId)).toBe(false)
    expect(routes.getTargetIfOwner('s', old.ownerId)).toBeUndefined()
    destroyed = true
    expect(routes.get('s')).toBeUndefined()
    expect(routes.getTargetIfOwner('s', current.ownerId)).toBeUndefined()
    expect(routes.removeIfOwner('s', current.ownerId)).toBe(true)
  })
})
