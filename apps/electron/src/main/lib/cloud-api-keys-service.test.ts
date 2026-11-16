import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PROMA_APP_QUOTA,
  MAX_PROMA_AGENT_INNER_KEYS,
  MAX_PROMA_APP_KEYS,
  PROMA_AGENT_INNER_KEY_NAME,
  buildPromaAppKeyName,
  decidePromaInnerKey,
  formatTodayYYYYMMDD,
  getPromaAppKeyLimitError,
  validatePromaAppKeyInput,
} from './cloud-api-keys-service'

describe('Proma App Key 输入校验', () => {
  test('Given 合法 kebab-case When 校验 Then 使用默认配额', () => {
    expect(validatePromaAppKeyInput({ appName: 'my-app-2', description: 'demo' })).toEqual({
      ok: true,
      appName: 'my-app-2',
      description: 'demo',
      quotaLimit: DEFAULT_PROMA_APP_QUOTA,
    })
  })

  test('Given 合法输入与自定义配额 When 校验 Then 保留配额', () => {
    const result = validatePromaAppKeyInput({ appName: 'app', description: 'demo', quotaLimit: 5 })
    expect(result).toMatchObject({ ok: true, quotaLimit: 5 })
  })

  test('Given 非法 appName When 校验 Then 返回官方文案', () => {
    for (const appName of ['My-App', 'my_app', '-app', 'app-', 'app--x', '', '应用']) {
      const result = validatePromaAppKeyInput({ appName, description: 'demo' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('must be kebab-case')
    }
  })

  test('Given 配额非正 When 校验 Then 返回官方文案', () => {
    const result = validatePromaAppKeyInput({ appName: 'app', description: 'demo', quotaLimit: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('must be > 0')
  })

  test('Given 描述超长 When 校验 Then 返回长度错误', () => {
    const result = validatePromaAppKeyInput({ appName: 'app', description: 'x'.repeat(201) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('description too long')
  })

  test('Given 描述恰为 200 When 校验 Then 通过', () => {
    expect(validatePromaAppKeyInput({ appName: 'app', description: 'x'.repeat(200) }).ok).toBe(true)
  })
})

describe('Proma App Key 命名', () => {
  test('Given 固定日期 When 生成名称 Then 使用本地 YYYYMMDD', () => {
    const date = new Date(2026, 0, 2, 10, 30)
    expect(formatTodayYYYYMMDD(date)).toBe('20260102')
    expect(buildPromaAppKeyName('my-app', date)).toBe('app-my-app-20260102')
  })
})

describe('Proma inner key 决策', () => {
  const activeKey = {
    name: PROMA_AGENT_INNER_KEY_NAME,
    status: 'ACTIVE' as const,
    key: 'pk_inner',
  }

  test('Given 存在 ACTIVE inner key When 决策 Then 复用并报告重复数', () => {
    const decision = decidePromaInnerKey([
      { name: 'other', status: 'ACTIVE', key: 'pk_other' },
      activeKey,
      { ...activeKey, key: 'pk_inner_2' },
      { name: PROMA_AGENT_INNER_KEY_NAME, status: 'DISABLED', key: 'pk_disabled' },
    ])
    expect(decision).toEqual({ action: 'reuse', key: 'pk_inner', duplicates: 2 })
  })

  test('Given 无同名 key When 决策 Then 创建', () => {
    expect(decidePromaInnerKey([{ name: 'other', status: 'ACTIVE', key: 'pk' }])).toEqual({ action: 'create' })
    expect(decidePromaInnerKey([])).toEqual({ action: 'create' })
  })

  test('Given 只有 DISABLED 同名 key 且未超限 When 决策 Then 创建', () => {
    const keys = Array.from({ length: MAX_PROMA_AGENT_INNER_KEYS - 1 }, (_, index) => ({
      name: PROMA_AGENT_INNER_KEY_NAME,
      status: 'DISABLED',
      key: `pk_${index}`,
    }))
    expect(decidePromaInnerKey(keys)).toEqual({ action: 'create' })
  })

  test('Given 同名 key 达到上限且无 ACTIVE When 决策 Then 返回错误', () => {
    const keys = Array.from({ length: MAX_PROMA_AGENT_INNER_KEYS }, (_, index) => ({
      name: PROMA_AGENT_INNER_KEY_NAME,
      status: 'DISABLED',
      key: `pk_${index}`,
    }))
    const decision = decidePromaInnerKey(keys)
    expect(decision.action).toBe('error')
    if (decision.action === 'error') {
      expect(decision.error).toContain('Too many')
      expect(decision.error).toContain('settings panel')
    }
  })
})

describe('Proma App Key 数量上限', () => {
  test('Given 19 个 app key When 判定 Then 仍可创建', () => {
    const keys = Array.from({ length: MAX_PROMA_APP_KEYS - 1 }, (_, index) => ({ name: `app-${index}` }))
    expect(getPromaAppKeyLimitError(keys)).toBeUndefined()
  })

  test('Given 达到 20 个 app key When 判定 Then 返回清理提示', () => {
    const keys = Array.from({ length: MAX_PROMA_APP_KEYS }, (_, index) => ({ name: `app-${index}` }))
    expect(getPromaAppKeyLimitError(keys)).toContain('Too many app keys')
  })

  test('Given 非 app 前缀 When 判定 Then 不计入上限', () => {
    const keys = Array.from({ length: MAX_PROMA_APP_KEYS }, (_, index) => ({ name: `manual-${index}` }))
    expect(getPromaAppKeyLimitError(keys)).toBeUndefined()
  })
})
