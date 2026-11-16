/**
 * 状态栏上下文窗口的解析规则。
 *
 * 背景：状态栏的「已用 / 窗口」比例直接决定自动压缩预警，窗口取错会让百分比失真。
 * 三种来源的优先级固定为：
 * 1. 用户在渠道里为该模型显式配置的 contextWindow（自定义网关唯一的可靠来源）；
 * 2. 运行时事件 / 状态栏已有的真实窗口；
 * 3. 按模型名推断——这里必须区分「已知」和「兜底猜测」（200K）。
 *
 * 猜测值只适合作为进度环的分母兜底，不能当成权威值写回状态栏，否则换模型、
 * 或渠道未回报真实窗口时，界面会稳定显示成 200K。
 */

import type { Channel } from '@proma/shared'
import { inferContextWindow, inferKnownContextWindow } from '@proma/shared'

/** 发送/重试一轮时写入流式状态的窗口：配置值 > 已知推断 > 历史值 > 200K 兜底。 */
export function resolveRunContextWindow(
  modelId: string | undefined,
  previous: number | undefined,
  channel?: Channel,
): number | undefined {
  const channelContextWindow = channel?.models.find((m) => m.id === modelId)?.contextWindow
  return channelContextWindow ?? inferContextWindow(modelId) ?? previous
}

/**
 * 切换模型时可立即采用的窗口：只认配置值与已知推断，不返回 200K 猜测。
 * 返回 undefined 表示「确定不了」，调用方应保留上一次的真实值而不是把它抹掉。
 */
export function resolveKnownRunContextWindow(
  modelId: string | undefined,
  channel?: Channel,
): number | undefined {
  const channelContextWindow = channel?.models.find((m) => m.id === modelId)?.contextWindow
  if (channelContextWindow != null && channelContextWindow > 0) return channelContextWindow
  return inferKnownContextWindow(modelId)
}
