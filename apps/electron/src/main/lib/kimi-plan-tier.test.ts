import { describe, expect, test } from 'bun:test'
import {
  extractKimiUserLevelName,
  formatKimiPlanName,
  resolveKimiPlanQuotaUrl,
  resolveKimiPlanRegion,
} from './kimi-plan-tier'

describe('Kimi 会员档位解析', () => {
  test('Given 档位藏在 data.user 包装里 When 解析 Then 读取 user_level_name', () => {
    const payload = {
      data: {
        user: {
          user_level_name: 'Kimi Pro',
          userLevelName: 'ignored',
        },
      },
    }

    expect(extractKimiUserLevelName(payload)).toBe('Kimi Pro')
  })

  test('Given 档位使用 camelCase When 解析 Then 兼容 userLevelName', () => {
    expect(extractKimiUserLevelName({ userLevelName: 'Max' })).toBe('Max')
  })

  test('Given profile 数组包装 When 解析 Then 取第一个合法档位并去除空白', () => {
    const payload = { profile: [{ user_level_name: '   ' }, { user_level_name: '  Basic  ' }] }

    expect(extractKimiUserLevelName(payload)).toBe('Basic')
  })

  test('Given 响应没有档位 When 解析 Then 返回 undefined，不伪造会员等级', () => {
    expect(extractKimiUserLevelName({ usage: { remaining: 10 } })).toBeUndefined()
    expect(extractKimiUserLevelName(null)).toBeUndefined()
    expect(extractKimiUserLevelName('Kimi Pro')).toBeUndefined()
  })

  test('Given 国内与海外 Base URL When 选择额度端点 Then 分别指向 kimi.com 与 kimi.ai', () => {
    expect(resolveKimiPlanRegion('https://api.kimi.com/coding/v1')).toBe('cn')
    expect(resolveKimiPlanRegion('https://api.kimi.ai/coding/v1')).toBe('global')
    expect(resolveKimiPlanRegion('')).toBe('cn')
    expect(resolveKimiPlanQuotaUrl('https://api.kimi.com/coding/v1'))
      .toBe('https://api.kimi.com/coding/v1/usages')
    expect(resolveKimiPlanQuotaUrl('https://api.kimi.ai/coding/v1'))
      .toBe('https://api.kimi.ai/coding/v1/usages')
  })

  test('Given 档位名 When 生成展示名 Then 避免重复 Kimi 前缀', () => {
    expect(formatKimiPlanName()).toBe('Kimi For Coding')
    expect(formatKimiPlanName('Pro')).toBe('Kimi Pro')
    expect(formatKimiPlanName('Kimi Max')).toBe('Kimi Max')
  })
})
