import { describe, expect, test } from 'bun:test'
import { inferContextWindow, inferKnownContextWindow, supports1MContext } from './context-window'
import {
  KIMI_K3_1_CONTEXT_WINDOW,
  KIMI_K3_256K_CONTEXT_WINDOW,
  getKimiContextWindow,
  getKimiModelPresets,
  isKimiK31Model,
  normalizeKimiModelId,
} from './kimi-model-capabilities'

describe('Kimi 模型能力', () => {
  test('Given 带空白与 [1m] 后缀 When 归一化 Then 得到稳定小写 ID', () => {
    expect(normalizeKimiModelId(' Kimi-K3.1-Pro[1m] ')).toBe('kimi-k3.1-pro')
    expect(normalizeKimiModelId(undefined)).toBe('')
  })

  test('Given 官方 K3.1 Pro 模型 ID When 判定 Then 兼容 kimi- 前缀与 Coding 无前缀', () => {
    for (const id of ['kimi-k3.1-pro', 'K3.1-PRO-HIGHSPEED', 'k3.1-pro', 'k3.1-pro-highspeed']) {
      expect(isKimiK31Model(id)).toBe(true)
    }
    for (const id of ['kimi-k3', 'k3-256k', 'kimi-k3.1-api', 'kimi-for-coding']) {
      expect(isKimiK31Model(id)).toBe(false)
    }
  })

  test('Given 官方目录模型 When 取上下文窗口 Then 区分 1M 与 256K', () => {
    expect(getKimiContextWindow('kimi-k3.1-pro')).toBe(KIMI_K3_1_CONTEXT_WINDOW)
    // 官方 K3.1 Pro Highspeed 仍属 K3.1 家族，窗口为 1M；256K 只属于
    // k3-256k 与 kimi-for-coding-highspeed 这两个独立 ID。
    expect(getKimiContextWindow('k3.1-pro-highspeed')).toBe(KIMI_K3_1_CONTEXT_WINDOW)
    expect(getKimiContextWindow('kimi-for-coding-highspeed')).toBe(KIMI_K3_256K_CONTEXT_WINDOW)
    expect(getKimiContextWindow('k3-256k')).toBe(KIMI_K3_256K_CONTEXT_WINDOW)
    expect(getKimiContextWindow('kimi-for-coding')).toBe(KIMI_K3_1_CONTEXT_WINDOW)
    expect(getKimiContextWindow('kimi-k3')).toBeUndefined()
  })

  test('Given Kimi 模型 When 通用上下文推断 Then 不被 K3 家族 1M 规则误放大', () => {
    expect(inferContextWindow('kimi-k3.1-pro')).toBe(KIMI_K3_1_CONTEXT_WINDOW)
    expect(inferContextWindow('k3.1-pro-highspeed[1m]')).toBe(KIMI_K3_1_CONTEXT_WINDOW)
    expect(inferContextWindow('k3-256k')).toBe(KIMI_K3_256K_CONTEXT_WINDOW)
    expect(inferContextWindow('kimi-for-coding-highspeed')).toBe(KIMI_K3_256K_CONTEXT_WINDOW)
    // kimi-k3 仍走 shared 的 1M 规则，不应被 K3.1 的目录值覆盖。
    expect(inferKnownContextWindow('kimi-k3')).toBe(1_000_000)
  })

  test('Given Kimi 模型 When 判断 1M 能力 Then 256K 不被标记为 1M', () => {
    expect(supports1MContext('kimi-k3.1-pro')).toBe(true)
    expect(supports1MContext('kimi-for-coding')).toBe(true)
    expect(supports1MContext('k3-256k')).toBe(false)
    expect(supports1MContext('kimi-for-coding-highspeed')).toBe(false)
  })

  test('Given 渠道 When 生成预置 Then kimi-api 带前缀、kimi-coding 用无前缀 ID', () => {
    expect(getKimiModelPresets('kimi-api').map((model) => model.id)).toEqual([
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
      'kimi-k3',
    ])
    expect(getKimiModelPresets('kimi-coding').map((model) => model.id)).toEqual([
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'kimi-for-coding',
    ])
  })
})
