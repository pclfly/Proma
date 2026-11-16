import { describe, expect, test } from 'bun:test'
import type { AgentPersonalDirective } from '@/types/settings'
import { inspectPersonalDirective } from '@/lib/personal-directive-config'

function directive(overrides: Partial<AgentPersonalDirective> = {}): AgentPersonalDirective {
  return { enabled: true, content: '', ...overrides }
}

describe('破甲全局配置判定', () => {
  test('Given enabled 且配置了 content When 检查 Then 可开启', () => {
    expect(inspectPersonalDirective(directive({ content: '按作战规范执行' }))).toBe('ready')
  })

  test('Given enabled 且只配置了 markdownPath When 检查 Then 可开启', () => {
    expect(inspectPersonalDirective(directive({ markdownPath: 'armor.md' }))).toBe('ready')
  })

  test('Given content 全是空白 When 检查 Then 视为无正文', () => {
    expect(inspectPersonalDirective(directive({ content: '  \n\t ' }))).toBe('empty')
  })

  test('Given enabled 且正文与路径都为空 When 检查 Then 视为无正文', () => {
    expect(inspectPersonalDirective(directive({ markdownPath: '   ' }))).toBe('empty')
  })

  test('Given 全局 enabled 为 false When 检查 Then 报告未启用（即使有正文）', () => {
    expect(inspectPersonalDirective(directive({ enabled: false, content: '正文' }))).toBe('disabled')
  })

  test('Given settings 里没有 personalDirective When 检查 Then 报告未启用', () => {
    expect(inspectPersonalDirective(undefined)).toBe('disabled')
  })
})
