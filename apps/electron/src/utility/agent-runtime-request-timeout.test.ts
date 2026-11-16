import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import { getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

describe('协作等待的跨进程期限', () => {
  const timeout = (input: unknown) => getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'mcp__collaboration__wait_for_delegations', input })
  test('Given 一小时业务等待 When 获取RPC期限 Then 包含传输余量而非两分钟', () => {
    expect(timeout({ timeoutSeconds: 3600 })).toBe(3_630_000)
    expect(timeout({})).toBe(3_630_000)
  })
  test('Given 非法或过大期限 When 规范化 Then 两端使用相同有界值', () => {
    expect(timeout({ timeoutSeconds: Infinity })).toBe(3_630_000)
    expect(timeout({ timeoutSeconds: -1 })).toBe(30_000)
    expect(timeout({ timeoutSeconds: 99999 })).toBe(7_230_000)
    expect(timeout({ timeoutSeconds: 0.5 })).toBe(30_500)
  })
  test('Given 非等待工具 When 计算期限 Then 不放宽其他RPC', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'mcp__collaboration__continue_delegation' })).toBe(120_000)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { toolName: 'AskUserQuestion' })).toBe(900_000)
  })
})
