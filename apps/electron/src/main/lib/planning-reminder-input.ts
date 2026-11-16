/**
 * 规划提醒输入校验。
 *
 * 官方 0.22.0 把 Agent 工具参数校验收敛为纯函数：
 * - targetType 只允许 todo / calendar_event；
 * - id 必须是非空字符串；
 * - triggerAt 必须是可表示为有效日期的正安全整数毫秒时间戳。
 */

import type { PlanningReminderTargetType } from '@proma/shared'

export interface CreatePlanningReminderInput {
  targetType: PlanningReminderTargetType
  targetId: string
  triggerAt: number
}

export interface UpdatePlanningReminderInput {
  id: string
  triggerAt: number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('提醒参数非法')
  }
  return value as Record<string, unknown>
}

function parseReminderId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('提醒 id 必填')
  return value
}

function timestamp(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error('请选择有效的提醒时间')
  }
  return value
}

export function parseCreateReminderInput(value: unknown): CreatePlanningReminderInput {
  const input = record(value)
  if (input.targetType !== 'todo' && input.targetType !== 'calendar_event') {
    throw new Error('提醒目标类型非法')
  }
  return {
    targetType: input.targetType,
    targetId: parseReminderId(input.targetId),
    triggerAt: timestamp(input.triggerAt),
  }
}

export function parseUpdateReminderInput(value: unknown): UpdatePlanningReminderInput {
  const input = record(value)
  return {
    id: parseReminderId(input.id),
    triggerAt: timestamp(input.triggerAt),
  }
}
