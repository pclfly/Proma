import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@proma/shared'
import {
  buildAssistantTurnRenderItems,
  buildNestedProcessItems,
  buildProcessSummaryText,
  formatProcessDuration,
} from './ProcessBlockGroup'

const thinking: SDKContentBlock = { type: 'thinking', thinking: '分析' }
const commentary: SDKContentBlock = { type: 'text', text: '过程说明', phase: 'commentary' }
const finalAnswer: SDKContentBlock = { type: 'text', text: '最终回复', phase: 'final_answer' }
const toolUse: SDKContentBlock = { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }

describe('过程组与最终回复拆分', () => {
  test('Given final_answer 显式阶段 When 拆分 Then 最终回复外置且过程组只含过程块', () => {
    const items = buildAssistantTurnRenderItems([thinking, commentary, finalAnswer])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    const group = items[0]
    if (group?.type !== 'process-group') throw new Error('expected process group')
    expect(group.items.map((item) => item.block)).toEqual([thinking, commentary])
  })

  test('Given 末尾仍是工具调用但有 final_answer When 拆分 Then 最终回复仍独立可见', () => {
    const items = buildAssistantTurnRenderItems([thinking, finalAnswer, toolUse])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block', 'block'])
    const trailing = items.slice(1)
    expect(trailing.map((item) => item.type === 'block' ? item.item.block.type : null)).toEqual([
      'text',
      'tool_use',
    ])
  })

  test('Given 流式 final_answer 尚未出现 When 拆分 Then 仍全部展示在过程组内', () => {
    const items = buildAssistantTurnRenderItems([thinking, toolUse], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group'])
  })

  test('Given 流式 final_answer 已出现 When 拆分 Then 立即外置最终回复', () => {
    const items = buildAssistantTurnRenderItems([thinking, finalAnswer], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
  })

  test('Given 末尾是没有最终答复的 commentary When 拆分 Then 不把过程回复当成答案', () => {
    // 官方 0.22.80：过程性回复不再混入最终答案。此时整轮仍属于过程组，
    // 等待显式 final_answer 或后续真实答复。
    const items = buildAssistantTurnRenderItems([
      thinking,
      toolUse,
      { type: 'text', text: '我先检查一下配置', phase: 'commentary' },
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group'])
    const group = items[0]
    if (group?.type !== 'process-group') throw new Error('expected process group')
    expect(group.items.map((item) => item.block.type)).toEqual(['thinking', 'tool_use', 'text'])
  })

  test('Given 无 phase 的普通尾部文本 When 拆分 Then 保持末尾连续 text 启发式', () => {
    const items = buildAssistantTurnRenderItems([
      thinking,
      { type: 'text', text: '普通回复' },
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
  })
})

describe('过程摘要文案', () => {
  test('Given 运行中 When 生成摘要 Then 先步数后实时耗时', () => {
    expect(buildProcessSummaryText({
      outcome: 'running',
      liveDurationMs: 12_300,
      steps: 3,
    })).toBe('正在执行任务 · 已完成 3 步 · 持续 12 秒')
  })

  test('Given 运行中且尚无步数 When 生成摘要 Then 只显示耗时', () => {
    expect(buildProcessSummaryText({
      outcome: 'running',
      liveDurationMs: 2_000,
      steps: 0,
    })).toBe('正在执行任务 · 持续 2 秒')
  })

  test('Given 已完成 When 生成摘要 Then 显示中文用时与步数', () => {
    expect(buildProcessSummaryText({
      outcome: 'completed',
      durationMs: 65_000,
      steps: 6,
    })).toBe('已完成，用时 1 分 5 秒 · 6 步')
  })

  test('Given 中断或失败 When 生成摘要 Then 标注终态且不带耗时', () => {
    expect(buildProcessSummaryText({ outcome: 'stopped', durationMs: 9_000, steps: 2 })).toBe('已停止')
    expect(buildProcessSummaryText({ outcome: 'failed', durationMs: 9_000, steps: 2 })).toBe('运行失败')
  })
})

describe('工具行吸收后续思考块', () => {
  test('Given 工具后连续思考 When 构建 Then 思考嵌套在工具行内且不再单独渲染', () => {
    const nested = buildNestedProcessItems([
      { block: toolUse, index: 0 },
      { block: thinking, index: 1 },
      { block: { ...thinking, thinking: '补充' }, index: 2 },
      { block: commentary, index: 3 },
      { block: { ...toolUse, id: 'tool-2' }, index: 4 },
    ])

    expect(nested.map((entry) => entry.index)).toEqual([0, 3, 4])
    expect(nested[0]?.nestedThinking.map((entry) => entry.index)).toEqual([1, 2])
    expect(nested[1]?.nestedThinking).toEqual([])
    expect(nested[2]?.nestedThinking).toEqual([])
  })

  test('Given 思考位于工具前 When 构建 Then 保持独立行', () => {
    const nested = buildNestedProcessItems([
      { block: thinking, index: 0 },
      { block: toolUse, index: 1 },
    ])

    expect(nested.map((entry) => entry.index)).toEqual([0, 1])
    expect(nested[0]?.nestedThinking).toEqual([])
  })

  test('Given 流式尾段思考 When 保持独立 Then 工具行不吸收最后一块', () => {
    const nested = buildNestedProcessItems([
      { block: toolUse, index: 0 },
      { block: thinking, index: 1 },
    ], { keepTailStandalone: true })

    expect(nested.map((entry) => entry.index)).toEqual([0, 1])
    expect(nested[0]?.nestedThinking).toEqual([])
  })

  test('Given 文本打断 When 构建 Then 只吸收紧随工具的连续思考', () => {
    const nested = buildNestedProcessItems([
      { block: toolUse, index: 0 },
      { block: commentary, index: 1 },
      { block: thinking, index: 2 },
    ])

    expect(nested.map((entry) => entry.index)).toEqual([0, 1, 2])
    expect(nested[0]?.nestedThinking).toEqual([])
  })
})

describe('过程耗时中文格式', () => {
  test('Given 不足一秒 When 格式化 Then 使用毫秒', () => {
    expect(formatProcessDuration(0)).toBe('0 毫秒')
    expect(formatProcessDuration(999)).toBe('999 毫秒')
  })

  test('Given 不足一分钟 When 格式化 Then 四舍五入到整秒', () => {
    expect(formatProcessDuration(1_000)).toBe('1 秒')
    expect(formatProcessDuration(12_300)).toBe('12 秒')
    expect(formatProcessDuration(59_600)).toBe('1 分')
  })

  test('Given 超过一分钟 When 格式化 Then 输出分与秒', () => {
    expect(formatProcessDuration(65_000)).toBe('1 分 5 秒')
    expect(formatProcessDuration(352_000)).toBe('5 分 52 秒')
    expect(formatProcessDuration(120_000)).toBe('2 分')
  })
})
