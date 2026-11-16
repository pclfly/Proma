import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { attachTurnDurationToLastAssistant, createTurnClock, resolveResultDurationMs } from './agent-turn-timing'

describe('轮次墙钟结算', () => {
  test('Given 同一 query 连续两轮 When 依次结算 Then 第二轮不重复累计前一轮时间', () => {
    const clock = createTurnClock(1_000)

    expect(clock.settle(11_000)).toBe(10_000)
    // 若按「当前时间 − query 起点」算，这里会得到 15_000，把第一轮的时间算了两遍
    expect(clock.settle(16_000)).toBe(5_000)
  })

  test('Given 时钟回拨 When 结算 Then 返回 0 而不是负数', () => {
    const clock = createTurnClock(10_000)

    expect(clock.settle(9_000)).toBe(0)
  })

  test('Given 尚未结算 When 查看已流逝 Then 不推进起点', () => {
    const clock = createTurnClock(1_000)

    expect(clock.elapsed(4_000)).toBe(3_000)
    expect(clock.settle(5_000)).toBe(4_000)
  })

  test('Given 恢复重试 When 重置起点 Then 失败尝试的时间不计入本轮', () => {
    const clock = createTurnClock(1_000)

    clock.reset(60_000)

    expect(clock.settle(65_000)).toBe(5_000)
  })
})

describe('result 落盘耗时', () => {
  test('Given 到达时已结算 When 落盘 Then 保留轮次墙钟而不是整轮累计值', () => {
    expect(resolveResultDurationMs(8_000, 90_000)).toBe(8_000)
  })

  test('Given 到达时没有结算值 When 落盘 Then 用传入的整轮耗时兜底', () => {
    expect(resolveResultDurationMs(undefined, 90_000)).toBe(90_000)
  })

  test('Given 两边都没有有效值 When 落盘 Then 不写入计时字段', () => {
    expect(resolveResultDurationMs(undefined, undefined)).toBeUndefined()
    expect(resolveResultDurationMs('8000', 0)).toBeUndefined()
  })
})

describe('停止轮的墙钟归属', () => {
  test('Given 停在工具执行中 When 挂墙钟 Then 写在本轮最后一条 assistant 上', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '帮我改代码' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    ] as unknown as SDKMessage[]

    expect(attachTurnDurationToLastAssistant(messages, 12_000)).toBe(true)
    expect((messages[1] as unknown as Record<string, unknown>)._turnDurationMs).toBe(12_000)
    expect((messages[0] as unknown as Record<string, unknown>)._turnDurationMs).toBeUndefined()
  })

  test('Given 本轮只有 assistant 之外的消息 When 挂墙钟 Then 不伪造计时', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '你好' }] } },
    ] as unknown as SDKMessage[]

    expect(attachTurnDurationToLastAssistant(messages, 5_000)).toBe(false)
    expect(attachTurnDurationToLastAssistant([], 5_000)).toBe(false)
    expect(attachTurnDurationToLastAssistant(messages, undefined)).toBe(false)
  })
})
