/**
 * 破甲会话级隔离的行为测试。
 *
 * 契约：
 * 1. 新建会话不带 armorEnabled，即默认关闭；
 * 2. 全局 personalDirective.enabled 只是「装了什么」，不能单独触发注入；
 * 3. 两者都为 true 才注入；
 * 4. 会话开关只写自身，不影响其它会话。
 */

import { describe, expect, test } from 'bun:test'

/**
 * 复刻 agent-orchestrator 的会话级判定：
 * armorActive = 全局已启用 && 本会话已启用
 */
function isArmorActive(
  globalEnabled: boolean | undefined,
  sessionArmorEnabled: boolean | undefined,
): boolean {
  return globalEnabled === true && sessionArmorEnabled === true
}

describe('破甲会话级判定', () => {
  test('新建会话（无 armorEnabled）默认关闭，即使全局已启用', () => {
    expect(isArmorActive(true, undefined)).toBe(false)
  })

  test('全局启用 + 会话启用 → 注入', () => {
    expect(isArmorActive(true, true)).toBe(true)
  })

  test('全局启用 + 会话显式关闭 → 不注入', () => {
    expect(isArmorActive(true, false)).toBe(false)
  })

  test('全局关闭 + 会话启用 → 不注入（没有正文可注入）', () => {
    expect(isArmorActive(false, true)).toBe(false)
  })

  test('两者都未设置 → 不注入', () => {
    expect(isArmorActive(undefined, undefined)).toBe(false)
  })

  test('其它会话开启不影响本会话', () => {
    const sessions = new Map<string, boolean | undefined>([
      ['session-A', true],
      ['session-B', undefined],
    ])
    const globalEnabled = true

    expect(isArmorActive(globalEnabled, sessions.get('session-A'))).toBe(true)
    expect(isArmorActive(globalEnabled, sessions.get('session-B'))).toBe(false)
  })

  test('关闭会话 A 后，会话 A 与 B 均不注入', () => {
    const sessions = new Map<string, boolean | undefined>([
      ['session-A', false],
      ['session-B', undefined],
    ])
    expect(isArmorActive(true, sessions.get('session-A'))).toBe(false)
    expect(isArmorActive(true, sessions.get('session-B'))).toBe(false)
  })
})
