import { describe, expect, test } from 'bun:test'
import {
  getAgentTokenActivityRange,
  getBeijingIsoDate,
  shiftIsoDate,
} from './cloud-usage-service'

describe('北京时间日期', () => {
  test('Given UTC 跨日时刻 When 取北京日期 Then 前进一天', () => {
    expect(getBeijingIsoDate(new Date('2026-01-01T16:30:00Z'))).toBe('2026-01-02')
    expect(getBeijingIsoDate(new Date('2026-01-01T15:59:59Z'))).toBe('2026-01-01')
  })

  test('Given 月初 UTC 时刻 When 取北京日期 Then 正确进位', () => {
    expect(getBeijingIsoDate(new Date('2026-02-28T17:00:00Z'))).toBe('2026-03-01')
  })
})

describe('ISO 日期偏移', () => {
  test('Given 普通日期 When 偏移 Then 返回 YYYY-MM-DD', () => {
    expect(shiftIsoDate('2026-01-10', 1)).toBe('2026-01-11')
    expect(shiftIsoDate('2026-01-10', -1)).toBe('2026-01-09')
  })

  test('Given 跨月/跨年 When 偏移 Then 正确进位', () => {
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftIsoDate('2025-12-31', 1)).toBe('2026-01-01')
  })

  test('Given 闰年 When 偏移 Then 正确处理 2 月 29 日', () => {
    expect(shiftIsoDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftIsoDate('2024-02-29', 1)).toBe('2024-03-01')
  })

  test('Given 非法日期 When 偏移 Then 抛出 RangeError（与官方一致）', () => {
    expect(() => shiftIsoDate('not-a-date', 1)).toThrow()
  })
})

describe('Agent Token 活跃度区间', () => {
  test('Given 当日 When 计算区间 Then 历史为前 364 天到昨天', () => {
    expect(getAgentTokenActivityRange('2026-11-09')).toEqual({
      today: '2026-11-09',
      historyStartDate: '2025-11-10',
      historyEndDate: '2026-11-08',
    })
  })

  test('Given 年初 When 计算区间 Then 正常跨年', () => {
    expect(getAgentTokenActivityRange('2026-01-01')).toEqual({
      today: '2026-01-01',
      historyStartDate: '2025-01-02',
      historyEndDate: '2025-12-31',
    })
  })
})
