import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './agent-prompt-builder'

/** 最小上下文：不绑定具体工作区，专注于「破甲」指令的注入行为。 */
function buildMinimalSystemPrompt(personalDirective: { enabled: boolean; content: string }): string {
  return buildSystemPrompt({
    sessionId: 'test-session',
    permissionMode: 'plan',
    currentModelId: 'model-id',
    personalDirective,
  })
}

describe('personal-directive injection into Agent system prompt', () => {
  test('Given personalDirective enabled with content When building prompt Then injects the content marker', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    expect(prompt).toContain('HELLO_PD_MARKER')
    expect(prompt).toContain('个人指令（破甲）')
  })

  test('Given personalDirective disabled When building prompt Then does not inject the content', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: false, content: 'HELLO_PD_MARKER' })
    expect(prompt).not.toContain('HELLO_PD_MARKER')
  })

  test('Given enabled but content is only whitespace Then does not inject an empty directive', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: '   ' })
    expect(prompt).not.toContain('个人指令（破甲）')
  })
})
