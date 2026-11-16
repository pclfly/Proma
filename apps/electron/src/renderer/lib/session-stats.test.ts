import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  areSessionStatsEqual,
  cacheHitPercentOf,
  computeSessionStats,
  foldSessionUsage,
  foldSessionUsageInto,
  formatCompactTokens,
  formatStatDuration,
  formatTokensPerSecond,
  liveMessagesNotInPersisted,
  statsFromFold,
  tokensPerSecondOf,
  type SessionStats,
  type UsageFold,
} from './session-stats'

interface AssistantUsage {
  input: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

function assistant(usage: AssistantUsage, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [],
      usage: {
        input_tokens: usage.input,
        ...(usage.output !== undefined && { output_tokens: usage.output }),
        ...(usage.cacheRead !== undefined && { cache_read_input_tokens: usage.cacheRead }),
        ...(usage.cacheWrite !== undefined && { cache_creation_input_tokens: usage.cacheWrite }),
      },
    },
    parent_tool_use_id: null,
    ...extra,
  } as unknown as SDKMessage
}

function userMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

/** 工具结果回传也是 user 消息，但它不是用户新输入，不能算一轮 */
function toolResultMessage(): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

const EMPTY_FOLD: UsageFold = {
  promptTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  timedOutputTokens: 0,
  decodeMs: 0,
  lastMainPromptTokens: null,
  lastMainModelId: null,
  turns: 0,
  steps: 0,
}

describe('foldSessionUsage', () => {
  test('counts prompt side as uncached + cache read + cache write', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 50, cacheRead: 900, cacheWrite: 0 }),
    ])

    // 提示侧 100 + 900 = 1000；输出 50
    expect(fold.promptTokens).toBe(1000)
    expect(fold.cacheReadTokens).toBe(900)
    expect(fold.outputTokens).toBe(50)
    expect(fold.lastMainPromptTokens).toBe(1000)
  })

  test('skips partial previews that carry no usage', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 20, cacheRead: 0 }),
      { type: 'assistant', message: { content: [] }, parent_tool_use_id: null, _partial: true } as unknown as SDKMessage,
    ])

    expect(fold.promptTokens).toBe(100)
    expect(fold.outputTokens).toBe(20)
  })

  test('accumulates across turns and ignores non-assistant messages', () => {
    const fold = foldSessionUsage([
      userMessage('hi'),
      assistant({ input: 10, output: 5, cacheRead: 90 }),
      assistant({ input: 20, output: 7, cacheRead: 80 }),
    ])

    expect(fold.promptTokens).toBe(200)
    expect(fold.cacheReadTokens).toBe(170)
    expect(fold.outputTokens).toBe(12)
  })

  test('tracks the last main-line prompt size, not subagent ones', () => {
    const fold = foldSessionUsage([
      assistant({ input: 1_000, output: 10 }),
      assistant({ input: 50, output: 5 }, { parent_tool_use_id: 'parent-1' }),
      assistant({ input: 2_000, output: 20 }),
    ])

    expect(fold.lastMainPromptTokens).toBe(2_000)
  })

  test('counts turns from user text and steps from model calls', () => {
    const fold = foldSessionUsage([
      userMessage('第一轮'),
      assistant({ input: 100, output: 10 }),
      toolResultMessage(),
      assistant({ input: 120, output: 10 }),
      userMessage('第二轮'),
      assistant({ input: 140, output: 10 }),
    ])

    // 工具结果不是新一轮；两条 assistant 各算一步
    expect(fold.turns).toBe(2)
    expect(fold.steps).toBe(3)
  })

  test('does not count subagent steps or synthetic user prompts', () => {
    const fold = foldSessionUsage([
      userMessage('主线输入'),
      { ...userMessage('Skill 展开 prompt'), isSynthetic: true } as unknown as SDKMessage,
      assistant({ input: 100, output: 10 }),
      assistant({ input: 50, output: 5 }, { parent_tool_use_id: 'parent-1' }),
    ])

    expect(fold.turns).toBe(1)
    expect(fold.steps).toBe(1)
  })

  test('only counts decode time on assistant messages that report it', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
      assistant({ input: 100, output: 200 }),
      assistant({ input: 100, output: 100 }, { _decodeMs: 1_500 }),
    ])

    expect(fold.timedOutputTokens).toBe(300)
    expect(fold.decodeMs).toBe(3_500)
    // 全部输出仍然计入总量，只是速度分母只含带计时的部分
    expect(fold.outputTokens).toBe(500)
  })

  test('ignores non-positive decode timings', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 0 }),
      assistant({ input: 100, output: 200 }, { _decodeMs: -5 }),
    ])

    expect(fold.timedOutputTokens).toBe(0)
    expect(fold.decodeMs).toBe(0)
  })

  test('falls back to result._durationMs for legacy turns without per-message timing', () => {
    const fold = foldSessionUsage([
      assistant({ input: 1_000, output: 200 }),
      assistant({ input: 1_000, output: 300 }),
      { type: 'result', subtype: 'success', _durationMs: 10_000 } as unknown as SDKMessage,
    ])

    // 一轮只累加一次分母，否则 500 tok / 20s 会把速度砍半
    expect(fold.timedOutputTokens).toBe(500)
    expect(fold.decodeMs).toBe(10_000)
  })

  test('prefers measured timing over the per-turn fallback', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
      { type: 'result', subtype: 'success', _durationMs: 60_000 } as unknown as SDKMessage,
    ])

    // 已有实测计时时不再用整轮耗时兜底，避免把工具等待算进解码时间
    expect(fold.timedOutputTokens).toBe(200)
    expect(fold.decodeMs).toBe(2_000)
  })

  test('ignores a result that carries no duration', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }),
      { type: 'result', subtype: 'success' } as unknown as SDKMessage,
    ])

    expect(fold.timedOutputTokens).toBe(0)
    expect(fold.decodeMs).toBe(0)
  })
})

describe('foldSessionUsageInto', () => {
  test('is incremental and does not mutate the base fold', () => {
    const base = foldSessionUsage([assistant({ input: 100, output: 10, cacheRead: 400 })])
    const next = foldSessionUsageInto(base, [assistant({ input: 50, output: 5, cacheRead: 200 })])

    expect(base.promptTokens).toBe(500)
    expect(base.outputTokens).toBe(10)
    expect(next.promptTokens).toBe(750)
    expect(next.outputTokens).toBe(15)
    expect(next.cacheReadTokens).toBe(600)
  })

  test('returns the base fold unchanged for an empty batch', () => {
    expect(foldSessionUsageInto(EMPTY_FOLD, [])).toBe(EMPTY_FOLD)
  })

  test('matches a single-shot fold of the concatenated messages', () => {
    const first = [assistant({ input: 10, output: 1, cacheRead: 5, cacheWrite: 2 })]
    const second = [assistant({ input: 20, output: 3, cacheRead: 7 }, { _decodeMs: 900 })]

    const incremental = foldSessionUsageInto(foldSessionUsage(first), second)
    const oneShot = foldSessionUsage([...first, ...second])

    expect(incremental).toEqual(oneShot)
  })
})

describe('cacheHitPercentOf', () => {
  test('returns null without prompt tokens', () => {
    expect(cacheHitPercentOf(0, 0)).toBeNull()
    expect(cacheHitPercentOf(100, 0)).toBeNull()
  })

  test('reports a full hit as 100', () => {
    expect(cacheHitPercentOf(1_000, 1_000)).toBe(100)
    expect(cacheHitPercentOf(1_200, 1_000)).toBe(100)
  })

  test('keeps one decimal so near-full hits stay distinguishable', () => {
    // 999/1000 = 99.9%：部分命中绝不报成 100%
    expect(cacheHitPercentOf(999, 1_000)).toBe(99.9)
    expect(cacheHitPercentOf(996, 1_000)).toBe(99.6)
    expect(cacheHitPercentOf(986, 1_000)).toBe(98.6)
    // 一位小数按常规四舍五入
    expect(cacheHitPercentOf(949, 1_000)).toBe(94.9)
    expect(cacheHitPercentOf(945, 1_000)).toBe(94.5)
  })

  test('projects the requested sample readings', () => {
    expect(cacheHitPercentOf(490_000, 1_000_000)).toBe(49)
    expect(cacheHitPercentOf(986_000, 1_000_000)).toBe(98.6)
  })
})

describe('tokensPerSecondOf', () => {
  test('divides output tokens by decode seconds', () => {
    // 860 tok / 10s = 86 tok/s
    expect(tokensPerSecondOf(860, 10_000)).toBeCloseTo(86, 5)
  })

  test('returns null without decode timing or output', () => {
    expect(tokensPerSecondOf(0, 1_000)).toBeNull()
    expect(tokensPerSecondOf(100, 0)).toBeNull()
  })
})

describe('formatters', () => {
  test('formats compact token counts', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(517)).toBe('517')
    expect(formatCompactTokens(12_200)).toBe('12.2K')
    expect(formatCompactTokens(945_000)).toBe('945K')
    expect(formatCompactTokens(1_200_000)).toBe('1.2M')
    expect(formatCompactTokens(1_500_000_000)).toBe('1.5B')
  })

  test('formats tokens per second with sub-10 precision', () => {
    expect(formatTokensPerSecond(86.4)).toBe('86')
    expect(formatTokensPerSecond(8.46)).toBe('8.5')
    expect(formatTokensPerSecond(-1)).toBe('0')
  })
})

describe('statsFromFold', () => {
  test('derives all four readings from a folded session', () => {
    // 提示侧 469.2k 未缓存 + 450.8k 缓存读 = 920k，输出 25k，合计 945k
    const fold = foldSessionUsage([
      assistant({ input: 469_200, output: 25_000, cacheRead: 450_800 }),
    ])
    const stats = statsFromFold(fold, 190_000, 1_000_000)

    expect(stats.totalTokens).toBe(945_000)
    expect(stats.cacheHitPercent).toBe(49)
    // 没有解码计时 → 不展示速度
    expect(stats.tokensPerSecond).toBeNull()
    expect(stats.contextTokens).toBe(190_000)
    expect(stats.contextPercent).toBe(19)
  })

  test('prefers live context readings over the folded prompt size', () => {
    const fold = foldSessionUsage([assistant({ input: 1_000, output: 10 })])
    const stats = statsFromFold(fold, 5_000, 200_000)

    expect(stats.contextTokens).toBe(5_000)
    expect(stats.contextPercent).toBe(3)
  })

  test('prefers the channel-configured window over live and inferred values', () => {
    const fold = foldSessionUsage([assistant({ input: 40_000, output: 10 })])
    const stats = statsFromFold(fold, 40_000, 200_000, () => 200_000, 1_000_000)

    expect(stats.contextWindow).toBe(1_000_000)
    expect(stats.contextPercent).toBe(4)
  })

  test('falls back to the last prompt size and inferred window when live values are gone', () => {
    const fold = foldSessionUsage([assistant({ input: 40_000, output: 10, cacheRead: 160_000 })])
    const stats = statsFromFold(fold, undefined, undefined, () => 1_000_000)

    expect(stats.contextTokens).toBe(200_000)
    expect(stats.contextWindow).toBe(1_000_000)
    expect(stats.contextPercent).toBe(20)
  })

  test('leaves context readings null when nothing is known', () => {
    const stats = statsFromFold(EMPTY_FOLD, undefined, undefined, () => undefined)

    expect(stats.totalTokens).toBe(0)
    expect(stats.cacheHitPercent).toBeNull()
    expect(stats.tokensPerSecond).toBeNull()
    expect(stats.contextTokens).toBeNull()
    expect(stats.contextWindow).toBeNull()
    expect(stats.contextPercent).toBeNull()
  })
})

describe('computeSessionStats', () => {
  test('sums the whole session rather than a single turn', () => {
    const stats = computeSessionStats({
      messages: [
        userMessage('第一轮'),
        assistant({ input: 10_000, output: 500, cacheRead: 90_000 }, { _decodeMs: 5_000 }),
        userMessage('第二轮'),
        assistant({ input: 2_000, output: 1_500, cacheRead: 98_000 }, { _decodeMs: 10_000 }),
      ],
      liveContextTokens: 100_000,
      liveContextWindow: 1_000_000,
    })

    // 提示侧 10k+90k+2k+98k = 200k；输出 2k
    expect(stats.totalTokens).toBe(202_000)
    expect(stats.cacheHitPercent).toBe(94)
    // (500 + 1500) tok / 15s ≈ 133 tok/s
    expect(stats.tokensPerSecond).toBeCloseTo(133.33, 1)
    expect(stats.contextPercent).toBe(10)
  })
})

describe('liveMessagesNotInPersisted', () => {
  test('drops live copies that already landed on disk', () => {
    const persisted = [assistant({ input: 10, output: 1 }, { uuid: 'a' })]
    const live = [
      assistant({ input: 10, output: 1 }, { uuid: 'a' }),
      { type: 'assistant', message: { content: [] }, parent_tool_use_id: null, uuid: 'b' } as unknown as SDKMessage,
    ]

    const fresh = liveMessagesNotInPersisted(persisted, live)

    expect(fresh).toHaveLength(1)
    expect((fresh[0] as unknown as Record<string, unknown>).uuid).toBe('b')
  })

  test('keeps live messages when nothing is persisted yet', () => {
    const live = [{ type: 'assistant', message: { content: [] }, parent_tool_use_id: null, uuid: 'a' } as unknown as SDKMessage]
    expect(liveMessagesNotInPersisted([], live)).toEqual(live)
  })

  test('deduplicates repeated uuids within the live batch', () => {
    const live = [
      assistant({ input: 10, output: 1 }, { uuid: 'x' }),
      assistant({ input: 20, output: 2 }, { uuid: 'x' }),
    ]

    const fresh = liveMessagesNotInPersisted([], live)

    expect(fresh).toHaveLength(1)
  })

  test('keeps messages without a uuid', () => {
    const live = [userMessage('无 uuid 的乐观消息')]
    expect(liveMessagesNotInPersisted([assistant({ input: 1 }, { uuid: 'a' })], live)).toHaveLength(1)
  })
})

describe('areSessionStatsEqual', () => {
  const base: SessionStats = {
    totalTokens: 945_000,
    cacheHitPercent: 49,
    tokensPerSecond: 86,
    contextTokens: 190_000,
    contextWindow: 1_000_000,
    contextPercent: 19,
    turns: 2,
    steps: 50,
  }

  test('treats identical readings as equal', () => {
    expect(areSessionStatsEqual(base, { ...base })).toBe(true)
  })

  test('detects a change in any reading', () => {
    expect(areSessionStatsEqual(base, { ...base, totalTokens: 945_001 })).toBe(false)
    expect(areSessionStatsEqual(base, { ...base, tokensPerSecond: 87 })).toBe(false)
    expect(areSessionStatsEqual(base, { ...base, cacheHitPercent: null })).toBe(false)
    expect(areSessionStatsEqual(base, { ...base, contextPercent: 20 })).toBe(false)
    expect(areSessionStatsEqual(base, { ...base, steps: 51 })).toBe(false)
  })
})

describe('明细统计（速度 / 用时 / TTFT / 未缓存输入）', () => {
  test('Given 多次带计时请求 When 汇总 Then 最新速度取最后一个样本', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
      assistant({ input: 100, output: 50 }, { _decodeMs: 1_000 }),
    ])
    const stats = statsFromFold(fold)

    expect(stats.latestTokensPerSecond).toBe(50)
    expect(stats.tokensPerSecond).toBeCloseTo(83.33, 1)
  })

  test('Given 模型解码与整轮耗时 When 汇总 Then 拆出模型用时和工具用时', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
      { type: 'result', subtype: 'success', _durationMs: 10_000 } as unknown as SDKMessage,
    ])
    const stats = statsFromFold(fold)

    expect(stats.modelDurationMs).toBe(2_000)
    expect(stats.toolDurationMs).toBe(8_000)
  })

  test('Given 只有整轮耗时 When 汇总 Then 模型用时兜底且工具用时为 0', () => {
    const fold = foldSessionUsage([
      assistant({ input: 100, output: 200 }),
      { type: 'result', subtype: 'success', _durationMs: 10_000 } as unknown as SDKMessage,
    ])
    const stats = statsFromFold(fold)

    expect(stats.modelDurationMs).toBe(10_000)
    expect(stats.toolDurationMs).toBe(0)
  })

  test('Given 没有 result 计时 When 汇总 Then 工具用时未知', () => {
    const stats = statsFromFold(foldSessionUsage([
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
    ]))

    expect(stats.modelDurationMs).toBe(2_000)
    expect(stats.toolDurationMs).toBeNull()
  })

  test('Given 同一会话多轮各自结算墙钟 When 汇总 Then 工具用时按每轮相加', () => {
    const stats = statsFromFold(foldSessionUsage([
      userMessage('第一轮'),
      assistant({ input: 100, output: 200 }, { _decodeMs: 1_000 }),
      { type: 'result', subtype: 'success', _durationMs: 10_000 } as unknown as SDKMessage,
      toolResultMessage(),
      userMessage('第二轮'),
      assistant({ input: 100, output: 200 }, { _decodeMs: 2_000 }),
      { type: 'result', subtype: 'success', _durationMs: 20_000 } as unknown as SDKMessage,
    ]))

    expect(stats.modelDurationMs).toBe(3_000)
    expect(stats.toolDurationMs).toBe(27_000)
  })

  test('Given 用户停止的轮次没有 result When 汇总 Then 用 assistant 上的轮次墙钟估算工具用时', () => {
    const stats = statsFromFold(foldSessionUsage([
      userMessage('帮我写个脚本'),
      assistant({ input: 100, output: 200 }, { _decodeMs: 1_500, _turnDurationMs: 9_500 }),
    ]))

    expect(stats.modelDurationMs).toBe(1_500)
    expect(stats.toolDurationMs).toBe(8_000)
  })

  test('Given 停止轮与已完成轮相邻 When 汇总 Then 两处墙钟各计一次不重复', () => {
    const stats = statsFromFold(foldSessionUsage([
      userMessage('第一轮'),
      assistant({ input: 100, output: 200 }, { _decodeMs: 1_000 }),
      { type: 'result', subtype: 'success', _durationMs: 10_000 } as unknown as SDKMessage,
      userMessage('第二轮'),
      assistant({ input: 100, output: 200 }, { _decodeMs: 1_000, _turnDurationMs: 4_000 }),
    ]))

    expect(stats.toolDurationMs).toBe(9_000 + 3_000)
  })

  test('Given 多条 TTFT When 汇总 Then 返回平均值', () => {
    const fold = foldSessionUsage([
      assistant({ input: 1, output: 1 }, { _ttftMs: 400 }),
      assistant({ input: 1, output: 1 }, { _ttftMs: 800 }),
    ])

    expect(statsFromFold(fold).averageTtftMs).toBe(600)
  })

  test('Given 缓存读写 When 汇总 Then 未缓存输入只统计 input_tokens', () => {
    const fold = foldSessionUsage([assistant({ input: 100, output: 10, cacheRead: 900, cacheWrite: 50 })])

    expect(statsFromFold(fold).uncachedInputTokens).toBe(100)
  })
})

describe('formatStatDuration', () => {
  test('中文耗时格式', () => {
    expect(formatStatDuration(850)).toBe('850毫秒')
    expect(formatStatDuration(7_700)).toBe('7.7秒')
    expect(formatStatDuration(30_000)).toBe('30秒')
    expect(formatStatDuration(60_000)).toBe('1分')
    expect(formatStatDuration(1_803_000)).toBe('30分3秒')
    expect(formatStatDuration(null)).toBe('暂无')
  })
})
