import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from './reasoning-profile'

describe('Kimi K3.1 官方模型 ID', () => {
  test('Given kimi-api 的 K3.1 Pro When 解析 Then 使用 API profile', () => {
    for (const modelId of ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
      expect(resolveReasoningProfile({ modelId, transport: 'anthropic-messages' })?.id).toBe('kimi-k3.1-api')
    }
  })

  test('Given kimi-coding 的无前缀 K3.1 Pro When 解析 Then 使用 Coding profile', () => {
    for (const modelId of ['k3.1-pro', 'k3.1-pro-highspeed']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })?.id).toBe('kimi-k3.1-coding')
    }
  })

  test('Given K3 与 K3.1 前缀重叠 When 解析 Then 不互相吞掉', () => {
    expect(resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'anthropic-messages' })?.id).toBe('kimi-k3')
    expect(resolveReasoningProfile({ modelId: 'kimi-k3.1-pro', transport: 'anthropic-messages' })?.id).toBe('kimi-k3.1-api')
  })
})
