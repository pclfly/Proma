import { describe, expect, test } from 'bun:test'
import { createFileScrollController, getFileBrowserScrollStateKey } from './file-scroll-controller'
import type { FileScrollTarget, FileScrollScheduler } from './file-scroll-controller'

function scheduler() {
  const tasks = new Set<() => void>()
  const clock: FileScrollScheduler = { schedule(callback) { tasks.add(callback); return () => { tasks.delete(callback) } } }
  return { clock, tick() { for (const task of [...tasks]) { tasks.delete(task); task() } }, size: () => tasks.size }
}
function target(top = 0, height = 1800): FileScrollTarget { return { scrollTop: top, scrollHeight: height, clientHeight: 200 } }

describe('Files 滚动记忆与真实恢复状态', () => {
  test('Given 异步目录高度不足 When 程序化clamp产生scroll后卸载 Then 不覆盖原先保存的目标', () => {
    const element = target(0, 300), saved: number[] = []
    const clock = scheduler()
    const c = createFileScrollController(element, 900, top => saved.push(top), clock.clock)
    expect(c.restore()).toBe(false)
    expect(element.scrollTop).toBe(100)
    c.scroll(); clock.tick(); c.dispose()
    expect(saved).toEqual([])
  })
  test('Given 内容先不足再展开 When 再次布局 Then 到原保存位置且恢复事件不落为用户位置', () => {
    const element = target(0, 300), saved: number[] = []
    const clock = scheduler()
    const c = createFileScrollController(element, 900, top => saved.push(top), clock.clock)
    c.restore(); c.scroll()
    element.scrollHeight = 1600
    expect(c.restore()).toBe(true)
    expect(element.scrollTop).toBe(900)
    c.scroll(); c.dispose()
    expect(saved).toEqual([])
  })
  test('Given 最后120ms有多个用户scroll When 立即切Tab Then 同步保存最后值而非等待计时器', () => {
    const element = target(), saved: number[] = []
    const clock = scheduler()
    const c = createFileScrollController(element, 0, top => saved.push(top), clock.clock)
    c.restore(); c.takeControl()
    element.scrollTop = 350; c.scroll()
    element.scrollTop = 380; c.scroll()
    expect(clock.size()).toBe(1)
    c.dispose(); c.dispose(); clock.tick()
    expect(saved).toEqual([380])
  })
  test('Given 延迟恢复期间用户主动滚动 When 内容后来到齐 Then 不再夺回旧位置', () => {
    const element = target(0, 300), saved: number[] = []
    const c = createFileScrollController(element, 900, top => saved.push(top))
    c.restore(); c.takeControl()
    element.scrollTop = 40; c.scroll()
    element.scrollHeight = 1800
    expect(c.restore()).toBe(true)
    expect(element.scrollTop).toBe(40)
    c.dispose()
    expect(saved).toEqual([40])
  })
  test('Given 新搜索接管滚动 When scrollIntoView并且搜索过期 Then 保存搜索位置而非恢复旧值', () => {
    const element = target(), saved: number[] = []
    const c = createFileScrollController(element, 900, top => saved.push(top))
    c.takeControl(); element.scrollTop = 130; c.scroll()
    c.restore()
    expect(element.scrollTop).toBe(130)
    c.dispose()
    expect(saved).toEqual([130])
  })
  test('Given A/B工作区来回切换 When 清理旧实例并恢复 Then 分别保存来源位置', () => {
    const state = new Map([['A', 650], ['B', 180]])
    const element = target()
    const a = createFileScrollController(element, state.get('A')!, top => { state.set('A', top) })
    a.restore(); a.takeControl(); element.scrollTop = 720; a.scroll(); a.dispose()
    const b = createFileScrollController(element, state.get('B')!, top => { state.set('B', top) })
    b.restore(); expect(element.scrollTop).toBe(180)
    b.takeControl(); element.scrollTop = 210; b.scroll(); b.dispose()
    const returned = createFileScrollController(element, state.get('A')!, () => {})
    returned.restore(); expect(element.scrollTop).toBe(720)
    returned.dispose(); expect(state.get('B')).toBe(210)
  })
  test('Given 窄/宽布局的同来源roots When 构造key Then 共享位置且项目/会话/不同根不串扰', () => {
    const roots = [{ path: 'D:/project', scope: 'project' }, { path: 'D:/extra', scope: 'project' }]
    const key = getFileBrowserScrollStateKey('A', 'project', roots)
    expect(getFileBrowserScrollStateKey('A', 'project', [...roots].reverse())).toBe(key)
    expect(getFileBrowserScrollStateKey('B', 'project', roots)).not.toBe(key)
    expect(getFileBrowserScrollStateKey('A', 'session', roots)).not.toBe(key)
    expect(getFileBrowserScrollStateKey('A', 'project', roots.slice(1))).not.toBe(key)
  })
  test('Given 已卸载的旧实例 When 迟到observer/scroll到达 Then 不写缓存或修改新宿主', () => {
    const element = target(), saved: number[] = []
    const c = createFileScrollController(element, 500, top => saved.push(top))
    c.dispose(); element.scrollTop = 1000; c.restore(); c.scroll()
    expect(element.scrollTop).toBe(1000)
    expect(saved).toEqual([])
  })
  test('Given 已恢复后非用户内容收缩 When clamp并回填 Then 仍恢复原目标而不写100', () => {
    const element = target(), saved: number[] = []
    const c = createFileScrollController(element, 900, top => saved.push(top))
    c.restore(); c.scroll()
    element.scrollHeight = 300; element.scrollTop = 100; c.scroll()
    element.scrollHeight = 1800; c.restore()
    expect(element.scrollTop).toBe(900)
    c.dispose()
    expect(saved).toEqual([])
  })
  test('Given 用户最后native scroll尚未派发 When 卸载 Then 捕获仍属旧宿主的实际位置', () => {
    const element = target(), saved: number[] = []
    const c = createFileScrollController(element, 400, top => saved.push(top))
    c.restore(); c.takeControl()
    element.scrollTop = 460; c.scroll()
    element.scrollTop = 480 // 尚未派发最后 scroll。
    c.dispose()
    expect(saved).toEqual([480])
  })
  test('Given 初始值无效 When 恢复 Then 以0开始且不会保存NaN或负数', () => {
    for (const initial of [NaN, Infinity, -20]) {
      const element = target()
      const c = createFileScrollController(element, initial, () => {})
      expect(c.restore()).toBe(true)
      expect(element.scrollTop).toBe(0)
      c.dispose()
    }
  })
})
