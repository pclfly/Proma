import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './agent-prompt-builder'

/** 最小上下文：不绑定具体工作区，专注于「破甲」指令的注入行为。 */
function buildMinimalSystemPrompt(personalDirective: { enabled: boolean; content: string }): string {
  return buildSystemPrompt({
    sessionId: 'test-session',
    permissionMode: 'plan',
    currentModelId: 'model-id',
    personalDirective,
    productivityTools: { todosEnabled: true, calendarEnabled: true, obsidianEnabled: true },
  })
}

describe('personal-directive injection into Agent system prompt', () => {
  test('Given personalDirective enabled with content When building prompt Then injects the content marker', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    expect(prompt).toContain('HELLO_PD_MARKER')
    expect(prompt).toContain('个人指令（破甲）')
  })

  test('Given personalDirective enabled Then wraps gen-3 content with Proma adapter', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    expect(prompt).toContain('Proma 适配层')
    expect(prompt).toContain('Bash')
    expect(prompt).toContain('AskUserQuestion')
    expect(prompt).toContain('TaskCreate')
    expect(prompt).toContain('HELLO_PD_MARKER')
    expect(prompt.indexOf('Proma 适配层')).toBeLessThan(prompt.indexOf('HELLO_PD_MARKER'))
  })

  test('Given personalDirective enabled Then injects after workflow and before tasks', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    const workflowAt = prompt.indexOf('## 工作流')
    const directiveAt = prompt.indexOf('## 个人指令（破甲）')
    const tasksAt = prompt.indexOf('## 任务、日程与自动化')
    expect(workflowAt).toBeGreaterThan(-1)
    expect(directiveAt).toBeGreaterThan(-1)
    expect(tasksAt).toBeGreaterThan(-1)
    expect(workflowAt).toBeLessThan(directiveAt)
    expect(directiveAt).toBeLessThan(tasksAt)
  })

  test('Given personalDirective disabled When building prompt Then does not inject the content', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: false, content: 'HELLO_PD_MARKER' })
    expect(prompt).not.toContain('HELLO_PD_MARKER')
    expect(prompt).not.toContain('Proma 适配层')
  })

  test('Given enabled but content is only whitespace Then does not inject an empty directive', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: '   ' })
    expect(prompt).not.toContain('个人指令（破甲）')
    expect(prompt).not.toContain('Proma 适配层')
  })
})
