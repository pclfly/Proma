import { describe, expect, test } from 'bun:test'
import { createPiResponseTimingTracker } from './pi-response-timing'

describe('createPiResponseTimingTracker', () => {
  test('measures TTFT from request start and decode time from the first delta', () => {
    const tracker = createPiResponseTimingTracker()
    const requestStartedAt = 1_000

    tracker.noteDelta('a', requestStartedAt, 1_400)
    // 后续增量不再移动首 token 锚点
    tracker.noteDelta('a', requestStartedAt, 2_000)
    tracker.noteDelta('a', requestStartedAt, 3_000)

    const timing = tracker.finish('a', 11_400)

    expect(timing.ttftMs).toBe(400)
    // 解码耗时 = 结束时刻 − 首 token，而不是减去请求发出时刻
    expect(timing.decodeMs).toBe(10_000)
  })

  test('omits TTFT when the request start time is unknown', () => {
    const tracker = createPiResponseTimingTracker()

    tracker.noteDelta('b', undefined, 5_000)
    const timing = tracker.finish('b', 7_500)

    expect(timing.ttftMs).toBeUndefined()
    expect(timing.decodeMs).toBe(2_500)
  })

  test('reports no timing for a message that never streamed', () => {
    const tracker = createPiResponseTimingTracker()

    expect(tracker.finish('never-seen', 9_999)).toEqual({})
  })

  test('forgets a message after it is finished', () => {
    const tracker = createPiResponseTimingTracker()
    tracker.noteDelta('c', 0, 100)
    tracker.finish('c', 200)

    expect(tracker.finish('c', 300)).toEqual({})
  })

  test('forget resets the anchor so a native retry re-times from scratch', () => {
    const tracker = createPiResponseTimingTracker()

    tracker.noteDelta('d', 1_000, 1_100)
    tracker.forget('d')
    tracker.noteDelta('d', 1_000, 9_000)
    const timing = tracker.finish('d', 10_000)

    // 重试后首 token 锚点重新定在 9_000，而不是沿用失败那次的 1_100
    expect(timing.ttftMs).toBe(8_000)
    expect(timing.decodeMs).toBe(1_000)
  })

  test('reset clears every tracked message', () => {
    const tracker = createPiResponseTimingTracker()

    tracker.noteDelta('e', 0, 10)
    tracker.reset()

    expect(tracker.finish('e', 20)).toEqual({})
  })

  test('ignores a decode window that never advanced', () => {
    const tracker = createPiResponseTimingTracker()

    tracker.noteDelta('f', 1_000, 2_000)
    const timing = tracker.finish('f', 2_000)

    expect(timing.ttftMs).toBe(1_000)
    expect(timing.decodeMs).toBeUndefined()
  })

  test('keeps per-message timing independent', () => {
    const tracker = createPiResponseTimingTracker()

    tracker.noteDelta('g', 0, 100)
    tracker.noteDelta('h', 0, 500)

    expect(tracker.finish('g', 1_100)).toEqual({ ttftMs: 100, decodeMs: 1_000 })
    expect(tracker.finish('h', 1_500)).toEqual({ ttftMs: 500, decodeMs: 1_000 })
  })
})
