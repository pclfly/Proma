import { describe, expect, test } from 'bun:test'
import { calculatePiAutoCompactionThresholdTokens } from '@proma/shared'
import { decideCurrentSessionCompaction, PI_COMPACTION_SCHEDULED_MESSAGE } from './pi-compaction-policy'

describe('CompactContext 阈值门控', () => {
  test('Given 上下文仅占窗口 36% When 模型请求压缩 Then 跳过且不终止回合', () => {
    const decision = decideCurrentSessionCompaction({ tokens: 377_831, contextWindow: 1_050_000 })

    expect(decision.scheduled).toBe(false)
    expect(decision.message).toContain('377,831')
    expect(decision.message).toContain('1,050,000')
    expect(decision.message).toContain('840,000')
    expect(decision.message).toContain('80%')
    expect(decision.usage).toEqual({
      tokens: 377_831,
      contextWindow: 1_050_000,
      thresholdTokens: 840_000,
    })
  })

  test('Given 上下文恰好等于阈值 When 模型请求压缩 Then 跳过（与 shouldCompact 的严格大于一致）', () => {
    const contextWindow = 1_050_000
    const threshold = calculatePiAutoCompactionThresholdTokens(contextWindow)

    const decision = decideCurrentSessionCompaction({ tokens: threshold, contextWindow })

    expect(decision.scheduled).toBe(false)
  })

  test('Given 上下文超过阈值 When 模型请求压缩 Then 安排压缩并给出续跑提示', () => {
    const decision = decideCurrentSessionCompaction({ tokens: 840_001, contextWindow: 1_050_000 })

    expect(decision.scheduled).toBe(true)
    expect(decision.message).toBe(PI_COMPACTION_SCHEDULED_MESSAGE)
  })

  test('Given 默认 200K 窗口 When 上下文 160,000 Then 跳过；160,001 Then 安排', () => {
    expect(decideCurrentSessionCompaction({ tokens: 160_000, contextWindow: 200_000 }).scheduled).toBe(false)
    expect(decideCurrentSessionCompaction({ tokens: 160_001, contextWindow: 200_000 }).scheduled).toBe(true)
  })

  test('Given 刚压缩完且 tokens 未知 When 模型请求压缩 Then 跳过并说明暂无可压缩内容', () => {
    const decision = decideCurrentSessionCompaction({ tokens: null, contextWindow: 1_050_000 })

    expect(decision.scheduled).toBe(false)
    expect(decision.message).toContain('刚完成压缩')
  })

  test('Given 无法判定上下文用量 When 模型请求压缩 Then 保持原行为放行，由 Pi 的 noop 兜底', () => {
    expect(decideCurrentSessionCompaction(undefined).scheduled).toBe(true)
    expect(decideCurrentSessionCompaction({ tokens: 1_000, contextWindow: 0 }).scheduled).toBe(true)
  })
})
