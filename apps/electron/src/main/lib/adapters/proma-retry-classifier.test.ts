import { describe, expect, test } from 'bun:test'
import { classifyPiRetryReason, installPromaRetryClassifier } from './pi-retry-control'

describe('Proma 重试分类器安装', () => {
  test('Given session 暴露 _isRetryableError When 安装 Then 网络错误可重试、账单 429 不重试', () => {
    const session = {
      _isRetryableError: (_message: unknown) => false,
    }
    expect(installPromaRetryClassifier(session)).toBe(true)

    expect(session._isRetryableError({ stopReason: 'error', errorMessage: 'read ECONNRESET' })).toBe(true)
    expect(session._isRetryableError({
      stopReason: 'error',
      errorMessage: '429 insufficient_quota: billing limit reached',
    })).toBe(false)
  })

  test('Given 非终态 error When 分类 Then 保留 Pi 原始判断', () => {
    const session = {
      _isRetryableError: (_message: unknown) => false,
    }
    installPromaRetryClassifier(session)

    expect(session._isRetryableError({ stopReason: 'end', errorMessage: 'read ECONNRESET' })).toBe(false)
  })

  test('Given Pi 原始判断为 true When 分类器无法判定 Then 不收紧官方范围', () => {
    const session = {
      _isRetryableError: (_message: unknown) => true,
    }
    installPromaRetryClassifier(session)

    expect(session._isRetryableError({ stopReason: 'error', errorMessage: 'upstream returned 503' })).toBe(true)
  })

  test('Given session 缺少 _isRetryableError When 安装 Then 返回 false 且不抛错', () => {
    expect(installPromaRetryClassifier({})).toBe(false)
    expect(installPromaRetryClassifier(undefined)).toBe(false)
  })

  test('Given 错误文案 When 取重试原因 Then 与分类器一致', () => {
    expect(classifyPiRetryReason('429 Too Many Requests')).toBe('rate_limited')
    expect(classifyPiRetryReason('read ECONNRESET')).toBe('connection')
  })
})
