import { describe, expect, test } from 'bun:test'
import { formatReminderDateTime, parseReminderDateTime } from './PlanningReminderManager'

describe('提醒时间的本地时区转换', () => {
  test('Given 绝对时间戳 When 格式化 Then 输出 datetime-local 可用的本地时间', () => {
    const timestamp = new Date(2026, 10, 4, 9, 5).getTime()
    expect(formatReminderDateTime(timestamp)).toBe('2026-11-04T09:05')
  })

  test('Given 一位数月日时分 When 格式化 Then 补零', () => {
    const timestamp = new Date(2026, 0, 2, 3, 4).getTime()
    expect(formatReminderDateTime(timestamp)).toBe('2026-01-02T03:04')
  })

  test('Given 午夜 When 格式化 Then 小时为 00 而非 24', () => {
    const timestamp = new Date(2026, 5, 15, 0, 0).getTime()
    expect(formatReminderDateTime(timestamp)).toBe('2026-06-15T00:00')
  })

  test('Given 格式化后再解析 When 往返 Then 时间戳一致（分钟精度）', () => {
    const timestamp = new Date(2026, 10, 4, 9, 5).getTime()
    expect(parseReminderDateTime(formatReminderDateTime(timestamp))).toBe(timestamp)
  })

  test('Given 空字符串 When 解析 Then 返回 undefined 而不是现在', () => {
    expect(parseReminderDateTime('')).toBeUndefined()
  })

  test('Given 非法字符串 When 解析 Then 返回 undefined', () => {
    expect(parseReminderDateTime('not-a-date')).toBeUndefined()
  })

  test('Given 合法输入 When 解析 Then 得到有限时间戳', () => {
    const parsed = parseReminderDateTime('2026-11-04T09:05')
    expect(parsed).toBeDefined()
    expect(Number.isFinite(parsed!)).toBe(true)
  })
})
