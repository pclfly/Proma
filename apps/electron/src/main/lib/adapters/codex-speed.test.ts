import { describe, expect, test } from 'bun:test'
import {
  CODEX_SPEEDS,
  getCodexSpeeds,
  isCodexSpeed,
  isCodexSpeedSupportedModel,
  resolveCodexSpeed,
} from '@proma/shared'
import { CODEX_SERVICE_TIERS, injectCodexSpeed } from './pi-codex-request-settings'

describe('Codex 速度档（0.21.67-12）', () => {
  test('Given 官方档位 When 读取常量 Then 为 standard/fast/ultrafast 三档', () => {
    expect([...CODEX_SPEEDS]).toEqual(['standard', 'fast', 'ultrafast'])
  })

  test('Given 合法与非法取值 When 校验 Then 只接受三档', () => {
    expect(isCodexSpeed('standard')).toBe(true)
    expect(isCodexSpeed('fast')).toBe(true)
    expect(isCodexSpeed('ultrafast')).toBe(true)
    expect(isCodexSpeed('priority')).toBe(false)
    expect(isCodexSpeed(undefined)).toBe(false)
    expect(isCodexSpeed(true)).toBe(false)
  })

  test('Given Astra 与 6.1 Sol When 读取档位 Then 支持 ultrafast', () => {
    expect(getCodexSpeeds('gpt-6-astra')).toEqual(['standard', 'fast', 'ultrafast'])
    expect(getCodexSpeeds('gpt-6.1-sol')).toEqual(['standard', 'fast', 'ultrafast'])
  })

  test('Given Terra 家族含 -1 变体 When 读取档位 Then 都支持 fast', () => {
    // 官方 0.21.68-02：Terra 复用 Codex 同款思考档位，-1 变体同族。
    expect(getCodexSpeeds('gpt-6.1-terra')).toEqual(['standard', 'fast'])
    expect(getCodexSpeeds('gpt-6.1-terra-1')).toEqual(['standard', 'fast'])
    expect(resolveCodexSpeed({ codexSpeed: 'fast' }, 'gpt-6.1-terra-1')).toBe('fast')
  })

  test('Given 普通 fast 模型 When 读取档位 Then 只有 standard/fast', () => {
    expect(getCodexSpeeds('gpt-6.1-terra')).toEqual(['standard', 'fast'])
    expect(getCodexSpeeds('gpt-5.6-terra')).toEqual(['standard', 'fast'])
  })

  test('Given 不支持 fast 的模型 When 读取档位 Then 只有 standard', () => {
    expect(getCodexSpeeds('gpt-5.4-mini')).toEqual(['standard'])
    expect(getCodexSpeeds(undefined)).toEqual(['standard'])
  })

  test('Given 模型不支持该档 When 解析 Then 回退 standard 而非发送无效 service tier', () => {
    expect(resolveCodexSpeed({ codexSpeed: 'ultrafast' }, 'gpt-6.1-terra')).toBe('standard')
    expect(isCodexSpeedSupportedModel('ultrafast', 'gpt-6.1-terra')).toBe(false)
    expect(isCodexSpeedSupportedModel('ultrafast', 'gpt-6-astra')).toBe(true)
  })

  test('Given 旧 codexFastMode=true When 无 codexSpeed Then 等价 fast', () => {
    expect(resolveCodexSpeed({ codexFastMode: true }, 'gpt-6.1-terra')).toBe('fast')
    expect(resolveCodexSpeed({ codexFastMode: false }, 'gpt-6.1-terra')).toBe('standard')
  })

  test('Given 新旧字段并存 When 解析 Then 显式 codexSpeed 优先', () => {
    expect(resolveCodexSpeed({ codexSpeed: 'ultrafast', codexFastMode: true }, 'gpt-6-astra')).toBe('ultrafast')
    expect(resolveCodexSpeed({ codexSpeed: 'standard', codexFastMode: true }, 'gpt-6-astra')).toBe('standard')
  })

  test('Given 非法 codexSpeed When 解析 Then 不抛错且回退旧字段或 standard', () => {
    expect(resolveCodexSpeed({ codexSpeed: 'turbo' }, 'gpt-6.1-terra')).toBe('standard')
    expect(resolveCodexSpeed({ codexSpeed: 'turbo', codexFastMode: true }, 'gpt-6.1-terra')).toBe('fast')
  })
})

describe('Codex service tier 注入', () => {
  test('Given 三档 When 读取映射 Then 与官方 CODEX_SERVICE_TIERS 一致', () => {
    expect(CODEX_SERVICE_TIERS).toEqual({ standard: 'default', fast: 'priority', ultrafast: 'ultrafast' })
  })

  test('Given standard When 注入 Then payload 原样返回', () => {
    const payload = { model: 'gpt-6-astra' }
    expect(injectCodexSpeed(payload, 'standard')).toBe(payload)
  })

  test('Given fast When 注入 Then service_tier 为 priority', () => {
    expect(injectCodexSpeed({ model: 'gpt-6.1-terra' }, 'fast')).toMatchObject({ service_tier: 'priority' })
  })

  test('Given ultrafast 且模型支持 When 注入 Then service_tier 为 ultrafast', () => {
    expect(injectCodexSpeed({ model: 'gpt-6-astra' }, 'ultrafast')).toMatchObject({ service_tier: 'ultrafast' })
  })

  test('Given ultrafast 但模型不支持 When 注入 Then 不改 payload', () => {
    const payload = { model: 'gpt-6.1-terra' }
    expect(injectCodexSpeed(payload, 'ultrafast')).toBe(payload)
  })

  test('Given 非对象 payload When 注入 Then 原样返回而不抛错', () => {
    expect(injectCodexSpeed(null, 'fast')).toBeNull()
    expect(injectCodexSpeed('x', 'fast')).toBe('x')
    expect(injectCodexSpeed([], 'fast')).toEqual([])
  })

  test('Given 注入 When 检查原 payload Then 不被修改', () => {
    const payload = { model: 'gpt-6-astra' }
    const snapshot = JSON.stringify(payload)
    injectCodexSpeed(payload, 'ultrafast')
    expect(JSON.stringify(payload)).toBe(snapshot)
  })
})
