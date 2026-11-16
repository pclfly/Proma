import { describe, expect, test } from 'bun:test'
import { parseCreateReminderInput, parseUpdateReminderInput } from './planning-reminder-input'

describe('规划提醒输入校验', () => {
  test('Given 合法创建参数 When 解析 Then 返回归一化字段', () => {
    expect(parseCreateReminderInput({
      targetType: 'todo',
      targetId: 'todo-1',
      triggerAt: 1_700_000_000_000,
    })).toEqual({
      targetType: 'todo',
      targetId: 'todo-1',
      triggerAt: 1_700_000_000_000,
    })
  })

  test('Given 非法目标类型 When 解析 Then 拒绝', () => {
    expect(() => parseCreateReminderInput({
      targetType: 'note',
      targetId: 'id',
      triggerAt: Date.now(),
    })).toThrow('目标类型非法')
  })

  test('Given 空白 id When 解析 Then 拒绝', () => {
    expect(() => parseCreateReminderInput({
      targetType: 'calendar_event',
      targetId: '   ',
      triggerAt: Date.now(),
    })).toThrow('id 必填')
    expect(() => parseUpdateReminderInput({ id: '', triggerAt: Date.now() }))
      .toThrow('id 必填')
  })

  test('Given 非法时间 When 解析 Then 拒绝 NaN/负数/非整数/超出日期范围', () => {
    for (const triggerAt of [Number.NaN, -1, 1.5, 8.64e15 + 1]) {
      expect(() => parseUpdateReminderInput({ id: 'r1', triggerAt })).toThrow('提醒时间')
    }
  })

  test('Given 非对象 When 解析 Then 拒绝', () => {
    expect(() => parseCreateReminderInput(null)).toThrow('提醒参数非法')
    expect(() => parseUpdateReminderInput([])).toThrow('提醒参数非法')
  })
})
