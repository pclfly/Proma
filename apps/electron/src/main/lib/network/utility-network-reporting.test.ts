import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createUtilityFailureObserver,
  currentUtilityRouteEpochSource,
  parseUtilityNetworkFailure,
  runWithUtilityNetworkReporter,
} from './utility-network-reporting'

const root = join(import.meta.dir, '..')

describe('Utility 网络失败上报', () => {
  test('Given epoch 匹配或非法 payload When 解析 Then 只接受合法通知', () => {
    expect(parseUtilityNetworkFailure({
      epoch: 2, scope: 'model', phase: 'stream', failure: 'timeout',
    }, 2)).toEqual({ epoch: 2, scope: 'model', phase: 'stream', failure: 'timeout' })
    expect(parseUtilityNetworkFailure({
      epoch: 3, scope: 'model', phase: 'stream', failure: 'timeout',
    }, 2)).toBeUndefined()
    expect(parseUtilityNetworkFailure({
      epoch: 2, scope: 'bad', phase: 'stream', failure: 'timeout',
    }, 2)).toBeUndefined()
    expect(parseUtilityNetworkFailure(null, 2)).toBeUndefined()
  })

  test('Given 当前 query reporter When 观察失败 Then 只上报一次且转换 stream unknown', () => {
    const notices: unknown[] = []
    const controller = new AbortController()
    runWithUtilityNetworkReporter({
      epoch: () => 7,
      report: (notice) => notices.push(notice),
    }, () => {
      const observe = createUtilityFailureObserver('model', controller.signal)!
      observe(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'stream')
      observe(new Error('again'), 'headers')
      expect(notices).toEqual([{ scope: 'model', epoch: 7, phase: 'stream', failure: 'stream-interrupted' }])
    })
  })

  test('Given 取消失败 When 观察 Then 不上报', () => {
    const notices: unknown[] = []
    runWithUtilityNetworkReporter({
      epoch: () => 1,
      report: (notice) => notices.push(notice),
    }, () => {
      const observe = createUtilityFailureObserver('mcp', new AbortController().signal)!
      observe(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'headers')
      expect(notices).toEqual([])
    })
  })

  test('Given query reporter When 读取 route epoch Then 返回同一代际', () => {
    runWithUtilityNetworkReporter({
      epoch: () => 0,
      routeEpoch: () => 42,
      report: () => undefined,
    }, () => {
      expect(currentUtilityRouteEpochSource()?.()).toBe(42)
    })
    expect(currentUtilityRouteEpochSource()).toBeUndefined()
  })

  test('Given utility fetch / query / adapter When 接线 Then 使用 reporter 与事件上报', () => {
    const fetchSource = readFileSync(join(import.meta.dir, 'system-fetch-utility.ts'), 'utf8')
    expect(fetchSource).toContain('createUtilityFailureObserver')
    expect(fetchSource).toContain('currentUtilityRouteEpochSource')
    const querySource = readFileSync(join(import.meta.dir, '..', '..', '..', 'utility', 'agent-runtime.ts'), 'utf8')
    expect(querySource).toContain('runWithUtilityNetworkReporter')
    expect(querySource).toContain('EVENT_NETWORK_FAILURE')
    const adapter = readFileSync(join(import.meta.dir, '..', 'adapters', 'pi-utility-adapter.ts'), 'utf8')
    expect(adapter).toContain('parseUtilityNetworkFailure')
    expect(adapter).toContain('recordUtilityFailure')
  })
})
