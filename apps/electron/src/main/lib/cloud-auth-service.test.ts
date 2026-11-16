import { describe, expect, test } from 'bun:test'
import { createApiError } from '@proma/cloud'
import {
  PRODUCTION_CLOUD_API_BASE_URL,
  getCloudAuthApiBaseUrl,
  isLocalCloudAuthPathUsable,
  isSameCloudFile,
  parseCloudUserSnapshot,
} from './cloud-auth-service'
import { getCloudErrorMessage, toSafeAuthFailure } from './cloud-service-types'

describe('Cloud Auth 基础 URL', () => {
  test('Given 无参数 When 取 Auth base URL Then 返回正式地址', () => {
    expect(getCloudAuthApiBaseUrl()).toBe(PRODUCTION_CLOUD_API_BASE_URL)
  })

  test('Given 带尾斜杠 When 取 Auth base URL Then 去掉尾斜杠', () => {
    expect(getCloudAuthApiBaseUrl('http://127.0.0.1:8787/api/v1///'))
      .toBe('http://127.0.0.1:8787/api/v1')
  })
})

describe('认证文件路径隔离判定', () => {
  test('Given 无正式版文件 When 判定 Then 可用本地路径', () => {
    expect(isLocalCloudAuthPathUsable({})).toBe(true)
  })

  test('Given 本地文件是符号链接 When 判定 Then 不可用', () => {
    expect(isLocalCloudAuthPathUsable({
      localFile: { dev: 1, ino: 2, isSymbolicLink: true },
    })).toBe(false)
  })

  test('Given 正式版文件是断链符号链接 When 判定 Then 不可用', () => {
    expect(isLocalCloudAuthPathUsable({
      productionFile: { dev: 1, ino: 2, isSymbolicLink: true },
    })).toBe(false)
  })

  test('Given 本地文件与正式版链接目标同文件 When 判定 Then 不可用', () => {
    expect(isLocalCloudAuthPathUsable({
      localFile: { dev: 10, ino: 20, isSymbolicLink: false },
      productionFile: { dev: 11, ino: 21, isSymbolicLink: true },
      productionTarget: { dev: 10, ino: 20 },
    })).toBe(false)
  })

  test('Given 两个配置目录相同 When 判定 Then 不可用', () => {
    expect(isLocalCloudAuthPathUsable({
      productionFile: { dev: 1, ino: 2, isSymbolicLink: false },
      localDirectory: { dev: 3, ino: 4 },
      productionDirectory: { dev: 3, ino: 4 },
    })).toBe(false)
  })

  test('Given 正式版文件正常且目录不同 When 判定 Then 可用', () => {
    expect(isLocalCloudAuthPathUsable({
      localFile: { dev: 1, ino: 2, isSymbolicLink: false },
      productionFile: { dev: 1, ino: 3, isSymbolicLink: false },
      localDirectory: { dev: 1, ino: 4 },
      productionDirectory: { dev: 1, ino: 5 },
    })).toBe(true)
  })

  test('Given 任一侧缺失 When 比较文件身份 Then 视为不同', () => {
    expect(isSameCloudFile(undefined, { dev: 1, ino: 2 })).toBe(false)
    expect(isSameCloudFile({ dev: 1, ino: 2 }, undefined)).toBe(false)
    expect(isSameCloudFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 })).toBe(true)
    expect(isSameCloudFile({ dev: 1, ino: 2 }, { dev: 1, ino: 3 })).toBe(false)
  })
})

describe('认证文件用户快照解析', () => {
  const identity = (stored: string): string => stored

  test('Given 合法快照 When 解析 Then 保留业务字段', () => {
    const user = parseCloudUserSnapshot(JSON.stringify({
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      status: 'APPROVED',
      image: 'https://img',
      extra: 'ignored',
    }), identity)
    expect(user).toEqual({
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      status: 'APPROVED',
      image: 'https://img',
      avatar: undefined,
    })
    expect(user).not.toHaveProperty('extra')
  })

  test('Given avatar 为 null When 解析 Then 保留 null', () => {
    const user = parseCloudUserSnapshot(JSON.stringify({
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      status: 'PENDING',
      avatar: null,
    }), identity)
    expect(user?.avatar).toBeNull()
  })

  test('Given 加密快照 When 解析 Then 先调用 decode', () => {
    const user = parseCloudUserSnapshot('cipher', (stored) => {
      expect(stored).toBe('cipher')
      return JSON.stringify({ id: 'u', email: 'e', name: 'n', status: 'DISABLED' })
    })
    expect(user?.status).toBe('DISABLED')
  })

  test('Given 非法内容 When 解析 Then 返回 null 而不抛错', () => {
    expect(parseCloudUserSnapshot('not-json', identity)).toBeNull()
    expect(parseCloudUserSnapshot('', identity)).toBeNull()
    expect(parseCloudUserSnapshot(undefined, identity)).toBeNull()
    expect(parseCloudUserSnapshot(JSON.stringify({ id: 'u', email: 'e', name: 'n', status: 'OTHER' }), identity)).toBeNull()
    expect(parseCloudUserSnapshot(JSON.stringify({ id: 'u', email: 'e', status: 'APPROVED' }), identity)).toBeNull()
    expect(parseCloudUserSnapshot('null', identity)).toBeNull()
  })
})

describe('Cloud 错误归一化', () => {
  test('Given 结构化 Cloud 错误 When 转安全失败 Then 保留 kind 与 retryable', () => {
    expect(toSafeAuthFailure(createApiError(429), 'fallback')).toEqual({
      success: false,
      error: '请求过于频繁，请稍后重试',
      errorReason: 'rate_limited',
      retryable: true,
    })
  })

  test('Given 普通 Error When 转安全失败 Then 使用 fallback 且可重试', () => {
    expect(toSafeAuthFailure(new Error('secret detail'), '登录失败')).toEqual({
      success: false,
      error: '登录失败',
      errorReason: 'unknown',
      retryable: true,
    })
  })

  test('Given 非 Error When 取错误文案 Then 返回 fallback', () => {
    expect(getCloudErrorMessage('boom', '兜底')).toBe('兜底')
    expect(getCloudErrorMessage(new Error('boom'))).toBe('boom')
    expect(getCloudErrorMessage(createApiError(401), '兜底')).toBe('认证已过期，请重新登录')
  })
})
