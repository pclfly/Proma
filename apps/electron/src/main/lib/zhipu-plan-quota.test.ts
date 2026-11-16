import { describe, expect, test } from 'bun:test'
import { parseZhipuQuotaData } from './zhipu-plan-quota'

const NOW = 1_700_000_000_000

describe('智谱 Coding Plan 额度解析', () => {
  test('Given 个人积分制响应 When 解析 Then 输出积分余额且不伪造 token 窗口', () => {
    const result = parseZhipuQuotaData({
      success: true,
      code: 200,
      data: {
        credits: {
          total: 10_000,
          remaining: 8_000,
          unit: '积分',
          nextResetTime: 1_784_365_200,
        },
      },
    }, 'GLM Coding Plan', 'zhipu-coding', NOW)

    expect(result).toMatchObject({
      supported: true,
      provider: 'zhipu-coding',
      planName: 'GLM Coding Plan',
      credits: {
        remaining: 8_000,
        total: 10_000,
        unit: '积分',
        resetAt: 1_784_365_200_000,
      },
      windows: [{
        type: 'custom',
        label: '积分余额',
        remainingPercent: 80,
        usedPercent: 20,
        remainingLabel: '8000 积分',
        showProgress: true,
      }],
      updatedAt: NOW,
    })
  })

  test('Given 团队积分 limit When 解析 Then 使用团队积分标签', () => {
    const result = parseZhipuQuotaData({
      success: true,
      code: 200,
      data: {
        limits: [{
          type: 'CREDIT_LIMIT',
          usage: 1_000,
          remaining: 400,
          currentValue: 600,
          nextResetTime: 1_784_365_200,
        }],
      },
    }, 'GLM Coding Plan 团队版', 'zhipu-coding-team', NOW)

    expect(result).toMatchObject({
      supported: true,
      provider: 'zhipu-coding-team',
      credits: { remaining: 400, total: 1_000, remainingLabel: '400 积分' },
      windows: [{
        type: 'custom',
        label: '团队积分',
        remainingPercent: 40,
        usedPercent: 60,
        resetAt: 1_784_365_200_000,
      }],
    })
  })

  test('Given 窗口制响应 When 解析 Then 保留 5 小时与每周窗口且不带积分', () => {
    const result = parseZhipuQuotaData({
      success: true,
      code: 200,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: 1_784_365_200 },
          { type: 'TOKENS_LIMIT', unit: 6, percentage: 10, nextResetTime: 1_784_966_400 },
        ],
      },
    }, 'GLM Coding Plan', 'zhipu-coding', NOW)

    expect(result).toMatchObject({
      supported: true,
      windows: [
        { type: '5h', label: '每 5 小时', remainingPercent: 75, usedPercent: 25 },
        { type: 'weekly', label: '每周额度', remainingPercent: 90, usedPercent: 10 },
      ],
    })
    expect(result.credits).toBeUndefined()
  })

  test('Given 积分对象缺少剩余值 When 解析 Then 不把缺失值当成 0 积分', () => {
    const result = parseZhipuQuotaData({
      success: true,
      code: 200,
      data: { credits: { total: 10_000, unit: '积分' } },
    }, 'GLM Coding Plan', 'zhipu-coding', NOW)

    expect(result.supported).toBe(false)
    expect(result.credits).toBeUndefined()
    expect(result.windows).toEqual([])
  })

  test('Given 查询失败 When 解析 Then 返回可展示的失败原因', () => {
    const result = parseZhipuQuotaData({ success: false, code: 401, msg: '鉴权失败' }, 'GLM Coding Plan', 'zhipu-coding', NOW)

    expect(result).toMatchObject({
      supported: false,
      windows: [],
      message: '鉴权失败',
      updatedAt: NOW,
    })
  })
})
