import { describe, expect, test } from 'bun:test'
import { createStallWatchdog, ROUTE_STALL_ERROR_MESSAGE, RouteStallError } from './stall-watchdog'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('网络路由卡死看门狗', () => {
  test('Given 路由切换后无进展 When 超过 stallMs Then 触发 onStall', async () => {
    let epoch = 1
    const start = Date.now()
    let stalls = 0
    const watchdog = createStallWatchdog({
      routeEpoch: () => epoch,
      stallMs: 30,
      tickMs: 5,
      now: () => 1_000 + (Date.now() - start),
      onStall: () => { stalls += 1 },
    })
    epoch = 2
    await wait(100)
    watchdog.stop()
    expect(stalls).toBe(1)
  })

  test('Given 切换后持续 progress When 未超时 Then 不触发', async () => {
    let epoch = 1
    let now = 1_000
    let stalls = 0
    const watchdog = createStallWatchdog({
      routeEpoch: () => epoch,
      stallMs: 100,
      tickMs: 5,
      now: () => now,
      onStall: () => { stalls += 1 },
    })
    epoch = 2
    now = 1_050
    watchdog.progress()
    now = 1_080
    await wait(20)
    watchdog.stop()
    expect(stalls).toBe(0)
  })

  test('Given stop When 继续 tick Then 不再触发', async () => {
    let stalls = 0
    const watchdog = createStallWatchdog({
      routeEpoch: () => 1,
      stallMs: 1,
      tickMs: 5,
      now: () => 1_000,
      onStall: () => { stalls += 1 },
    })
    watchdog.stop()
    await wait(20)
    expect(stalls).toBe(0)
  })

  test('Given RouteStallError Then 暴露稳定错误文案', () => {
    const error = new RouteStallError()
    expect(error.name).toBe('RouteStallError')
    expect(error.message).toBe(ROUTE_STALL_ERROR_MESSAGE)
  })
})
