import { describe, expect, test } from 'bun:test'
import type { PlanQuotaSource } from '@proma/shared'
import {
  formatPlanQuotaCountdown,
  formatPlanQuotaWindowValue,
  selectPlanQuotaIslandWindows,
} from './plan-quota-display'

const NOW = 1_700_000_000_000

function source(windows: PlanQuotaSource['windows']): PlanQuotaSource {
  return {
    channelId: 'kimi',
    provider: 'kimi-coding',
    label: 'Kimi',
    windows,
    updatedAt: NOW,
  }
}

describe('额度胶囊倒计时与窗口选择', () => {
  test('Given 5H 与周窗口 When 选择胶囊窗口 Then 两者并排保留各自 resetAt', () => {
    const windows = selectPlanQuotaIslandWindows(source([
      { type: '5h', label: '每 5 小时', remainingPercent: 80, usedPercent: 20, resetAt: NOW + 3_600_000 },
      { type: 'weekly', label: '每周额度', remainingPercent: 50, usedPercent: 50, resetAt: NOW + 86_400_000 },
    ]))

    expect(windows.map((window) => window.type)).toEqual(['5h', 'weekly'])
  })

  test('Given 只有周窗口 When 选择胶囊窗口 Then 不补 5H', () => {
    const windows = selectPlanQuotaIslandWindows(source([
      { type: 'weekly', label: '每周额度', remainingPercent: 50, usedPercent: 50 },
    ]))

    expect(windows).toHaveLength(1)
    expect(windows[0]?.type).toBe('weekly')
  })

  test('Given 自定义积分窗口 When 选择胶囊窗口 Then 只展示真实存在的一个窗口', () => {
    const windows = selectPlanQuotaIslandWindows(source([
      { type: 'custom', label: '积分余额', remainingPercent: 40, usedPercent: 60, remainingLabel: '400 积分' },
    ]))

    expect(windows).toHaveLength(1)
    expect(formatPlanQuotaWindowValue(windows[0]!)).toBe('400 积分')
  })

  test('Given 倒计时穿越 1 小时与 24 小时边界 When 格式化 Then 单位切换且不出现 0 分', () => {
    expect(formatPlanQuotaCountdown(NOW + 59_000, NOW)).toBe('<1分')
    expect(formatPlanQuotaCountdown(NOW + 60_000, NOW)).toBe('1分')
    expect(formatPlanQuotaCountdown(NOW + 3_599_999, NOW)).toBe('1时')
    expect(formatPlanQuotaCountdown(NOW + 3_600_000, NOW)).toBe('1时')
    expect(formatPlanQuotaCountdown(NOW + 7_200_000, NOW)).toBe('2时')
    expect(formatPlanQuotaCountdown(NOW + 86_400_000, NOW)).toBe('1天')
    expect(formatPlanQuotaCountdown(NOW + 93_600_000, NOW)).toBe('1天2时')
  })

  test('Given 已过期或缺少重置时间 When 格式化 Then 不把未知时间显示成 0', () => {
    expect(formatPlanQuotaCountdown(NOW - 1, NOW)).toBe('待刷新')
    expect(formatPlanQuotaCountdown(undefined, NOW)).toBeNull()
    expect(formatPlanQuotaCountdown(Number.NaN, NOW)).toBeNull()
  })
})
