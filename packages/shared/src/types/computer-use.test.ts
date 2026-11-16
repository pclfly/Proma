import { describe, expect, test } from 'bun:test'
import { COMPUTER_USE_IPC_CHANNELS } from './computer-use'

describe('Computer Use 共享 IPC 契约', () => {
  test('Given 官方 0.22.0 通道 When 读取常量 Then 字符串保持一致', () => {
    expect(COMPUTER_USE_IPC_CHANNELS).toEqual({
      GET_INSTALLATION_STATUS: 'computer-use:get-installation-status',
      GET_SETTINGS: 'computer-use:get-settings',
      SET_DRIVER_PATH: 'computer-use:set-driver-path',
      SET_AUTHORIZATION: 'computer-use:set-authorization',
      GET_PREVIEW: 'computer-use:get-preview',
      DISMISS_PREVIEW: 'computer-use:dismiss-preview',
      ACTIVATE_PREVIEW: 'computer-use:activate-preview',
      RETRY_PREVIEW: 'computer-use:retry-preview',
      PREPARE_STREAM: 'computer-use:prepare-stream',
      FALLBACK_STREAM: 'computer-use:fallback-stream',
    })
  })

  test('Given 通道常量 When 检查唯一性 Then 每个通道只出现一次', () => {
    const values = Object.values(COMPUTER_USE_IPC_CHANNELS)
    expect(values).toHaveLength(10)
    expect(new Set(values).size).toBe(10)
  })
})
