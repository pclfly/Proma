import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CLOUD_API_CONFIG,
  DEFAULT_CLOUD_API_TIMEOUT_MS,
  PRODUCTION_CLOUD_API_BASE_URL,
  getCloudApiConfig,
  normalizeCloudBaseUrl,
  normalizeCloudTimeout,
  resolveCloudApiUrl,
} from './config'
import { getPromaMode, isCloudMode } from './mode'

describe('Cloud API 配置', () => {
  test('Given 无覆盖项 When 读取配置 Then 返回官方默认地址与 30s 超时', () => {
    const config = getCloudApiConfig()
    expect(config.baseUrl).toBe(PRODUCTION_CLOUD_API_BASE_URL)
    expect(config.baseUrl).toBe('https://api.proma.cool/api/v1')
    expect(config.timeout).toBe(DEFAULT_CLOUD_API_TIMEOUT_MS)
    expect(DEFAULT_CLOUD_API_CONFIG.timeout).toBe(30_000)
  })

  test('Given 带尾斜杠和空白的地址 When 归一化 Then 去掉尾斜杠', () => {
    expect(normalizeCloudBaseUrl('  https://example.test/api/v1/  ')).toBe('https://example.test/api/v1')
    expect(normalizeCloudBaseUrl('https://example.test///')).toBe('https://example.test')
  })

  test('Given 空地址 When 归一化 Then 回退正式地址', () => {
    expect(normalizeCloudBaseUrl('')).toBe(PRODUCTION_CLOUD_API_BASE_URL)
    expect(normalizeCloudBaseUrl(undefined)).toBe(PRODUCTION_CLOUD_API_BASE_URL)
    expect(normalizeCloudBaseUrl(null)).toBe(PRODUCTION_CLOUD_API_BASE_URL)
  })

  test('Given 非法超时 When 归一化 Then 回退默认值', () => {
    expect(normalizeCloudTimeout(undefined)).toBe(DEFAULT_CLOUD_API_TIMEOUT_MS)
    expect(normalizeCloudTimeout(Number.NaN)).toBe(DEFAULT_CLOUD_API_TIMEOUT_MS)
    expect(normalizeCloudTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CLOUD_API_TIMEOUT_MS)
    expect(normalizeCloudTimeout(-1)).toBe(DEFAULT_CLOUD_API_TIMEOUT_MS)
  })

  test('Given 合法超时 When 归一化 Then 向下取整并保留 0', () => {
    expect(normalizeCloudTimeout(1500.9)).toBe(1500)
    expect(normalizeCloudTimeout(0)).toBe(0)
  })

  test('Given 覆盖项 When 读取配置 Then 覆盖生效', () => {
    const config = getCloudApiConfig({ baseUrl: 'http://127.0.0.1:8787/api/v1/', timeout: 5_000 })
    expect(config).toEqual({ baseUrl: 'http://127.0.0.1:8787/api/v1', timeout: 5_000 })
  })
})

describe('Cloud API 地址拼接', () => {
  test('Given 标准 path When 拼接 Then 使用单斜杠', () => {
    expect(resolveCloudApiUrl('https://api.proma.cool/api/v1', '/auth/me'))
      .toBe('https://api.proma.cool/api/v1/auth/me')
  })

  test('Given path 缺少前导斜杠 When 拼接 Then 自动补齐', () => {
    expect(resolveCloudApiUrl('https://api.proma.cool/api/v1', 'auth/me'))
      .toBe('https://api.proma.cool/api/v1/auth/me')
  })

  test('Given 空 path When 拼接 Then 返回根地址', () => {
    expect(resolveCloudApiUrl('https://api.proma.cool/api/v1/', '  '))
      .toBe('https://api.proma.cool/api/v1')
  })

  test('Given 带查询串的 path When 拼接 Then 保留查询串', () => {
    expect(resolveCloudApiUrl('https://api.proma.cool/api/v1', '/me/usage?page=2&page_size=20'))
      .toBe('https://api.proma.cool/api/v1/me/usage?page=2&page_size=20')
  })
})

describe('Cloud 运行模式', () => {
  test('Given PROMA_MODE=cloud When 判定 Then 进入 cloud 模式', () => {
    expect(isCloudMode({ PROMA_MODE: 'cloud' })).toBe(true)
    expect(getPromaMode({ PROMA_MODE: 'cloud' })).toBe('cloud')
  })

  test('Given 未设置或其它值 When 判定 Then 保持 local', () => {
    expect(isCloudMode({})).toBe(false)
    expect(getPromaMode({})).toBe('local')
    expect(getPromaMode({ PROMA_MODE: 'CLOUD' })).toBe('local')
  })
})
