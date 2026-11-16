import { describe, expect, test } from 'bun:test'
import { createUpdateCheckScheduler } from './update-check-scheduler'

interface FakeTimer {
  callback: () => void
  at: number
}

function createTimers() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, FakeTimer>()
  return {
    setTimeoutFn(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
      const id = nextId++
      timers.set(id, { callback, at: now + delayMs })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn(handle: ReturnType<typeof setTimeout>): void {
      timers.delete(handle as unknown as number)
    },
    now: () => now,
    get size(): number {
      return timers.size
    },
    advance(ms: number): void {
      now += ms
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.callback()
      }
    },
    nextDelay(): number | undefined {
      return [...timers.values()][0]?.at
    },
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('更新检查调度', () => {
  test('Given 启动 When 初始延迟到达 Then 检查一次并安排下一周期', async () => {
    const timers = createTimers()
    let calls = 0
    const scheduler = createUpdateCheckScheduler({
      check: async () => {
        calls += 1
      },
      now: timers.now,
      random: () => 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })
    scheduler.start()
    expect(timers.nextDelay()).toBe(10_000)
    timers.advance(10_000)
    await flush()
    expect(calls).toBe(1)
    expect(timers.nextDelay()).toBe(10_000 + 60 * 60 * 1_000 * 0.9)
    scheduler.dispose()
  })

  test('Given 首次完成 When 冷却期内激活 Then 跳过；冷却后恢复', async () => {
    const timers = createTimers()
    let calls = 0
    const scheduler = createUpdateCheckScheduler({
      check: async () => {
        calls += 1
      },
      now: timers.now,
      random: () => 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })
    scheduler.start()
    timers.advance(10_000)
    await flush()
    expect(calls).toBe(1)

    scheduler.notifyActive()
    await flush()
    expect(calls).toBe(1)

    timers.advance(15 * 60 * 1_000)
    scheduler.notifyActive()
    await flush()
    expect(calls).toBe(2)
    scheduler.dispose()
  })

  test('Given 检查在途 When 再次通知 Then 复用同一个 Promise', async () => {
    const timers = createTimers()
    let calls = 0
    let release: (() => void) | undefined
    const scheduler = createUpdateCheckScheduler({
      check: () => new Promise<void>((resolve) => {
        calls += 1
        release = resolve
      }),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })
    scheduler.start()
    timers.advance(10_000)
    scheduler.notifyOnline()
    scheduler.notifyActive()
    await flush()
    expect(calls).toBe(1)
    release?.()
    await flush()
    scheduler.dispose()
  })

  test('Given dispose When 到达原定时间 Then 不再检查', async () => {
    const timers = createTimers()
    let calls = 0
    const scheduler = createUpdateCheckScheduler({
      check: async () => {
        calls += 1
      },
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })
    scheduler.start()
    scheduler.dispose()
    timers.advance(60_000)
    await flush()
    expect(calls).toBe(0)
    expect(timers.size).toBe(0)
  })
})
