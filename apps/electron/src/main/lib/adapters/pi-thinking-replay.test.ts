import { describe, expect, test } from 'bun:test'
import {
  applyThinkingReplayPolicy,
  armThinkingStripForSession,
  buildPrefixFingerprint,
  consumeThinkingStripForSession,
  createThinkingReplayState,
  describePrefixDrift,
  isClaudeFamilyModelId,
  isOpaqueUpstream400,
  recordPrefixFingerprint,
  resolveThinkingReplayMode,
} from './pi-thinking-replay'

const signedThinking = { type: 'thinking', thinking: 'secret', thinkingSignature: 'sig-1' }
const unsignedThinking = { type: 'thinking', thinking: 'plain' }
const user = (text: string) => ({ role: 'user', content: text })
const assistant = (blocks: unknown[]) => ({ role: 'assistant', content: blocks })
const supported = { supported: true }

describe('Pi thinking replay 策略', () => {
  test('Given legacy When 应用 Then 原样返回', () => {
    const messages = [user('u'), assistant([signedThinking])]
    const state = createThinkingReplayState('legacy')
    expect(applyThinkingReplayPolicy(messages, state, supported)).toBe(messages)
  })

  test('Given turn When 应用 Then 只保留最后一轮之后的签名 thinking', () => {
    const messages = [
      user('u1'),
      assistant([signedThinking]),
      user('u2'),
      assistant([signedThinking]),
    ]
    const result = applyThinkingReplayPolicy(messages, createThinkingReplayState('turn'), supported)
    expect((result[1] as { content: unknown[] }).content).toEqual([])
    expect((result[3] as { content: unknown[] }).content).toEqual([signedThinking])
  })

  test('Given 存在 compaction summary When 应用 Then 全量剥离', () => {
    const messages = [
      user('u1'),
      assistant([signedThinking]),
      { role: 'compactionSummary', content: 'summary' },
      assistant([signedThinking]),
    ]
    const result = applyThinkingReplayPolicy(messages, createThinkingReplayState('turn'), supported)
    expect((result[1] as { content: unknown[] }).content).toEqual([])
    expect((result[3] as { content: unknown[] }).content).toEqual([])
  })

  test('Given none When 应用 Then 全量剥离；非 anthropic 协议不处理', () => {
    const messages = [user('u'), assistant([signedThinking])]
    const stripped = applyThinkingReplayPolicy(messages, createThinkingReplayState('none'), supported)
    expect((stripped[1] as { content: unknown[] }).content).toEqual([])
    expect(applyThinkingReplayPolicy(messages, createThinkingReplayState('none'), { supported: false })).toBe(messages)
  })

  test('Given 未签名 thinking When 应用 Then 保留', () => {
    const messages = [user('u'), assistant([unsignedThinking])]
    const result = applyThinkingReplayPolicy(messages, createThinkingReplayState('none'), supported)
    expect((result[1] as { content: unknown[] }).content).toEqual([unsignedThinking])
  })

  test('Given 非法环境变量 When 解析 Then 返回 undefined 交给默认值', () => {
    expect(resolveThinkingReplayMode('none')).toBe('none')
    expect(resolveThinkingReplayMode(' TURN ')).toBe('turn')
    expect(resolveThinkingReplayMode('legacy')).toBe('legacy')
    expect(resolveThinkingReplayMode('invalid')).toBeUndefined()
  })
})

describe('Thinking 前缀指纹与强制剥离', () => {
  test('Given system/会话/thinking When 生成指纹 Then 计数正确', () => {
    const fingerprint = buildPrefixFingerprint([
      { role: 'system', content: 'sys' },
      user('u'),
      assistant([signedThinking]),
    ], 1000)
    expect(fingerprint.at).toBe(1000)
    expect(fingerprint.messageCount).toBe(2)
    expect(fingerprint.signedThinkingCount).toBe(1)
    expect(fingerprint.systemLength).toBe(3)
  })

  test('Given 超过上限 When 记录 Then 只保留最近三条', () => {
    const state = createThinkingReplayState('turn')
    for (let i = 0; i < 5; i += 1) {
      recordPrefixFingerprint(state, buildPrefixFingerprint([user(`u${i}`)]))
    }
    expect(state.fingerprints).toHaveLength(3)
    expect(describePrefixDrift(state)).toContain('会话序列变化')
  })

  test('Given 强制剥离标记 When 消费 Then 生效一次并遵守 TTL', () => {
    armThinkingStripForSession('session-a', 1000)
    expect(consumeThinkingStripForSession('session-a', 2000)).toBe(true)
    expect(consumeThinkingStripForSession('session-a', 2000)).toBe(false)

    armThinkingStripForSession('session-b', 1000)
    expect(consumeThinkingStripForSession('session-b', 1000 + 6 * 60 * 60 * 1_000 + 1)).toBe(false)
  })

  test('Given Claude/opaque 400 When 判定 Then 命中', () => {
    expect(isClaudeFamilyModelId('claude-opus-4-6')).toBe(true)
    expect(isClaudeFamilyModelId('gpt-6-astra')).toBe(false)
    expect(isOpaqueUpstream400('upstream http 400')).toBe(true)
    expect(isOpaqueUpstream400('upstream request failed')).toBe(true)
    expect(isOpaqueUpstream400('invalid request')).toBe(false)
  })
})
