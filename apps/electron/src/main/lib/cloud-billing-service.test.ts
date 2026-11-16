import { describe, expect, test } from 'bun:test'
import {
  GITHUB_COPILOT_USAGE_URL,
  parseGithubCopilotPlanQuotaResponse,
  parseQuotaResetTimestamp,
  parseQuotaWindow,
  resolveGithubCopilotPlanName,
  resolveGithubCopilotUsageUrl,
} from './cloud-billing-service'

const NOW = 1_800_000_000_000

describe('额度 reset 时间解析', () => {
  test('Given YYYY-MM-DD When 解析 Then 返回 UTC 零点时间戳', () => {
    expect(parseQuotaResetTimestamp('2026-01-02')).toBe(Date.parse('2026-01-02T00:00:00Z'))
  })

  test('Given 带时区 ISO When 解析 Then 返回对应时间戳', () => {
    expect(parseQuotaResetTimestamp('2026-01-02T03:04:05Z'))
      .toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(parseQuotaResetTimestamp('2026-01-02T03:04:05+08:00'))
      .toBe(Date.parse('2026-01-02T03:04:05+08:00'))
  })

  test('Given 非法日期/时间/格式 When 解析 Then 返回 undefined', () => {
    expect(parseQuotaResetTimestamp('2026-02-31')).toBeUndefined()
    expect(parseQuotaResetTimestamp('2026-13-01')).toBeUndefined()
    expect(parseQuotaResetTimestamp('2026-01-02T25:00:00Z')).toBeUndefined()
    expect(parseQuotaResetTimestamp('2026-01-02T03:04:05')).toBeUndefined()
    expect(parseQuotaResetTimestamp('2026/01/02')).toBeUndefined()
    expect(parseQuotaResetTimestamp(42)).toBeUndefined()
  })
})

describe('单个额度窗口解析', () => {
  test('Given unlimited When 解析 Then 生成非计量窗口', () => {
    expect(parseQuotaWindow({ unlimited: true }, 'Premium', 123)).toEqual({
      type: 'custom',
      label: 'Premium',
      remainingLabel: '不限量',
      remainingPercent: 0,
      usedPercent: 0,
      showProgress: false,
      resetAt: 123,
    })
  })

  test('Given entitlement/remaining When 解析 Then 计算百分比与展示文案', () => {
    expect(parseQuotaWindow({ entitlement: 100, remaining: 25 }, 'Chat', undefined)).toEqual({
      type: 'custom',
      label: 'Chat',
      remainingPercent: 25,
      usedPercent: 75,
      remainingLabel: '25 / 100',
    })
  })

  test('Given percent_remaining 越界 When 解析 Then 截断到 0-100', () => {
    expect(parseQuotaWindow({ percent_remaining: 150 }, 'Chat', undefined)?.remainingPercent).toBe(100)
    expect(parseQuotaWindow({ percent_remaining: -5 }, 'Chat', undefined)?.remainingPercent).toBe(0)
  })

  test('Given 字符串数字 When 解析 Then 接受并转换', () => {
    expect(parseQuotaWindow({ entitlement: '10', remaining: '2.5' }, 'Chat', undefined))
      .toMatchObject({ remainingPercent: 25, usedPercent: 75, remainingLabel: '2.5 / 10' })
  })

  test('Given 全 0 或缺少比例 When 解析 Then 返回 undefined', () => {
    expect(parseQuotaWindow({ entitlement: 0, remaining: 0 }, 'Chat', undefined)).toBeUndefined()
    expect(parseQuotaWindow({}, 'Chat', undefined)).toBeUndefined()
    expect(parseQuotaWindow(null, 'Chat', undefined)).toBeUndefined()
  })
})

describe('Copilot 套餐名', () => {
  test('Given 官方套餐值 When 映射 Then 返回展示名', () => {
    expect(resolveGithubCopilotPlanName('free')).toBe('GitHub Copilot Free')
    expect(resolveGithubCopilotPlanName('pro')).toBe('GitHub Copilot Pro')
    expect(resolveGithubCopilotPlanName('pro+')).toBe('GitHub Copilot Pro+')
    expect(resolveGithubCopilotPlanName('pro_plus')).toBe('GitHub Copilot Pro+')
    expect(resolveGithubCopilotPlanName('business')).toBe('GitHub Copilot Business')
    expect(resolveGithubCopilotPlanName('enterprise')).toBe('GitHub Copilot Enterprise')
    expect(resolveGithubCopilotPlanName('unknown')).toBe('GitHub Copilot')
  })
})

describe('Copilot 配额响应解析', () => {
  test('Given 完整响应 When 解析 Then 输出 premium/chat/补全窗口', () => {
    const quota = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'pro',
      quota_reset_date: '2026-02-01',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 150, percent_remaining: 50 },
        chat: { entitlement: 50, remaining: 10, percent_remaining: 20 },
        completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100 },
      },
    }, NOW)

    expect(quota.supported).toBe(true)
    expect(quota.provider).toBe('github-copilot')
    expect(quota.planName).toBe('GitHub Copilot Pro')
    expect(quota.updatedAt).toBe(NOW)
    expect(quota.windows.map((window) => window.label)).toEqual(['Premium', 'Chat', '补全'])
    expect(quota.windows[0]?.remainingLabel).toBe('150 / 300')
    expect(quota.windows[0]?.resetAt).toBe(Date.parse('2026-02-01T00:00:00Z'))
  })

  test('Given snapshots 缺失 chat When 解析 Then 回退 monthly/limited 配额', () => {
    const quota = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'business',
      monthly_quotas: { chat: 100, completions: 500 },
      limited_user_quotas: { chat: 40, completions: 100 },
    }, NOW)
    expect(quota.windows).toHaveLength(2)
    expect(quota.windows[0]).toMatchObject({ label: 'Chat', remainingPercent: 40, remainingLabel: '40 / 100' })
    expect(quota.windows[1]).toMatchObject({ label: '补全', remainingPercent: 20 })
  })

  test('Given 按量计费 When 解析 Then 最前面插入计费方式窗口', () => {
    const quota = parseGithubCopilotPlanQuotaResponse({
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: { entitlement: 10, remaining: 5 },
      },
    }, NOW)
    expect(quota.windows[0]).toEqual({
      type: 'custom',
      label: '计费方式',
      remainingLabel: '按量计费',
      remainingPercent: 0,
      usedPercent: 0,
      showProgress: false,
      resetAt: undefined,
    })
    expect(quota.windows).toHaveLength(2)
  })

  test('Given 无可用窗口 When 解析 Then 返回不支持及提示', () => {
    const quota = parseGithubCopilotPlanQuotaResponse({}, NOW)
    expect(quota.supported).toBe(false)
    expect(quota.windows).toEqual([])
    expect(quota.message).toContain('未返回可用额度数据')
  })

  test('Given 非对象响应 When 解析 Then 返回格式错误', () => {
    expect(parseGithubCopilotPlanQuotaResponse(null, NOW).message).toBe('GitHub Copilot 额度响应格式错误')
    expect(parseGithubCopilotPlanQuotaResponse('x', NOW).supported).toBe(false)
  })
})

describe('Copilot 用量 URL', () => {
  test('Given 未填写企业域 When 解析 Then 使用官方默认地址', () => {
    expect(resolveGithubCopilotUsageUrl()).toBe(GITHUB_COPILOT_USAGE_URL)
    expect(resolveGithubCopilotUsageUrl('')).toBe(GITHUB_COPILOT_USAGE_URL)
  })

  test('Given github.com（含协议与尾斜杠）When 解析 Then 映射 api.github.com', () => {
    expect(resolveGithubCopilotUsageUrl('github.com')).toBe('https://api.github.com/copilot_internal/user')
    expect(resolveGithubCopilotUsageUrl('https://github.com/')).toBe('https://api.github.com/copilot_internal/user')
    expect(resolveGithubCopilotUsageUrl('HTTPS://GITHUB.COM')).toBe('https://api.github.com/copilot_internal/user')
  })

  test('Given 企业 GHE 域 When 解析 Then 加 api. 前缀', () => {
    expect(resolveGithubCopilotUsageUrl('corp.ghe.com')).toBe('https://api.corp.ghe.com/copilot_internal/user')
    expect(resolveGithubCopilotUsageUrl('https://corp.ghe.com/')).toBe('https://api.corp.ghe.com/copilot_internal/user')
    expect(resolveGithubCopilotUsageUrl('api.corp.ghe.com')).toBe('https://api.corp.ghe.com/copilot_internal/user')
  })

  test('Given 非 github/ghe 域或带路径端口 When 解析 Then 返回 undefined', () => {
    expect(resolveGithubCopilotUsageUrl('evil.com')).toBeUndefined()
    expect(resolveGithubCopilotUsageUrl('https://github.com/path')).toBeUndefined()
    expect(resolveGithubCopilotUsageUrl('https://github.com:443')).toBeUndefined()
    expect(resolveGithubCopilotUsageUrl('http://github.com')).toBeUndefined()
    expect(resolveGithubCopilotUsageUrl('github')).toBeUndefined()
  })
})
