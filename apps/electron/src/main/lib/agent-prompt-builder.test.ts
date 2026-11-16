import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, resolvePersonalDirectiveSkillRoots, resolveSeepSystemPrompt } from './agent-prompt-builder'
import type { AgentPersonalDirective } from '../../types'

/** 最小上下文：不绑定具体工作区，专注于「破甲」指令的注入行为。 */
function buildMinimalSystemPrompt(personalDirective: AgentPersonalDirective): string {
  return buildSystemPrompt({
    sessionId: 'test-session',
    permissionMode: 'plan',
    currentModelId: 'model-id',
    personalDirective,
    productivityTools: { todosEnabled: true, calendarEnabled: true, obsidianEnabled: true },
  })
}

const tempDirs: string[] = []

/** 建临时目录写入破甲正文文件；markdownPath 用绝对路径，绕过 settings.json 相对解析。 */
function writeDirectiveFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-pd-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body, 'utf-8')
  return path
}

/** 建一个临时「技能根」目录，可在其下按需创建子目录（模拟 Seep 的 Tool/skill 布局）。 */
function makeSkillRoot(childDirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-skills-'))
  tempDirs.push(dir)
  for (const child of childDirs) mkdirSync(join(dir, child), { recursive: true })
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('personal-directive injection into Agent system prompt', () => {
  test('Given personalDirective enabled with content When building prompt Then injects the content marker', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    expect(prompt).toContain('HELLO_PD_MARKER')
    expect(prompt).toContain('个人指令（破甲）')
  })

  test('Given personalDirective enabled Then wraps the directive with Proma adapter', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'HELLO_PD_MARKER' })
    expect(prompt).toContain('Proma 适配层')
    expect(prompt).toContain('AskUserQuestion')
    // 官方 0.22.0 已下线任务工具族，提示词不能再要求模型创建进度任务。
    expect(prompt).not.toContain('TaskCreate')
    expect(prompt).not.toContain('TaskUpdate')
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

  test('Given enabled but directive only whitespace Then does not inject an empty directive', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: '   ' })
    expect(prompt).not.toContain('个人指令（破甲）')
    expect(prompt).not.toContain('Proma 适配层')
  })
})

describe('personal-directive markdownPath resolution', () => {
  test('Given markdownPath points to a real file Then injects the file body over content', () => {
    const path = writeDirectiveFile('directive.md', 'FILE_BODY_MARKER')
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'STALE_CONTENT_MARKER', markdownPath: path })
    expect(prompt).toContain('FILE_BODY_MARKER')
    expect(prompt).not.toContain('STALE_CONTENT_MARKER')
  })

  test('Given markdownPath points to a missing file Then falls back to content', () => {
    const missing = join(tmpdir(), 'proma-pd-does-not-exist', 'directive.md')
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'FALLBACK_MARKER', markdownPath: missing })
    expect(prompt).toContain('FALLBACK_MARKER')
  })

  test('Given markdownPath file is blank Then falls back to content', () => {
    const path = writeDirectiveFile('blank.md', '   \n\n')
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'FALLBACK_MARKER', markdownPath: path })
    expect(prompt).toContain('FALLBACK_MARKER')
  })

  test('Given disabled Then markdownPath is not read at all', () => {
    const path = writeDirectiveFile('directive.md', 'FILE_BODY_MARKER')
    const prompt = buildMinimalSystemPrompt({ enabled: false, content: '', markdownPath: path })
    expect(prompt).not.toContain('FILE_BODY_MARKER')
  })
})

describe('Proma adapter coverage over foreign directive clauses', () => {
  const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'PD_MARKER' })

  test('Given adapter Then declares persona precedence without changing the Pi runtime facts', () => {
    expect(prompt).toContain('身份与语声')
    expect(prompt).toContain('Pi Agent SDK')
  })

  test('Given Pi read-only skill loading When adapting instructions Then uses the catalog location and never invents a Skill tool', () => {
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('`read`')
    expect(prompt).toContain('location')
    expect(prompt).not.toContain('用 Skill 工具加载')
    expect(prompt).not.toContain('Skill 加载技能')
  })

  test('Given external skill roots When building the Pi prompt Then reading SKILL.md is the valid loading mechanism', () => {
    const local = makeSkillRoot(['redteam-ops'])
    const withRoots = buildMinimalSystemPrompt({ enabled: true, content: 'PD_MARKER', localSkillRootPath: local })
    expect(withRoots).toContain('通过 `read`')
    expect(withRoots).not.toContain('不要用 Read 直接读 SKILL.md')
    expect(withRoots).not.toContain('用 `Skill` 工具按 name 加载')
  })

  test('Given adapter Then excludes other workbench install scripts and paths', () => {
    expect(prompt).toContain('setup/install.ps1')
    expect(prompt).toContain('~/.zcode')
    expect(prompt).toContain('不属于 Proma 运行时')
  })

  test('Given adapter Then declares the armor switch is the combat-mode switch', () => {
    expect(prompt).toContain('破甲开关就是作战模式开关')
    // Seep v1.8.2 起状态在会话内存，磁盘标志已废弃
    expect(prompt).toContain('lab-mode.flag` 已废弃')
    expect(prompt).toContain('不要读取、不要检查')
  })

  test('Given adapter Then enforces Proma four-level heading start in replies', () => {
    expect(prompt).toContain('四级起')
    expect(prompt).toContain('不使用 `#`、`##`、`###`')
  })

  test('Given adapter Then states the adapter only adjudicates conflicts, not the whole directive', () => {
    expect(prompt).toContain('本层只裁决冲突点')
  })

  test('Given the legacy gen-3 adapter wording Then it is gone', () => {
    expect(prompt).not.toContain('offline documentation engine')
    expect(prompt).not.toContain('FORMAT ANCHORS')
    expect(prompt).not.toContain('[USER]/[OUTPUT]')
  })
})

describe('personal-directive external skill roots', () => {
  test('Given enabled with an existing official skill root Then resolves it to an absolute path', () => {
    const root = makeSkillRoot(['softseep'])
    const roots = resolvePersonalDirectiveSkillRoots({ enabled: true, content: 'x', skillPaths: [root] })
    expect(roots.official).toEqual([root])
    expect(roots.local).toEqual([])
    expect(roots.all).toEqual([root])
  })

  test('Given enabled with a local skill root Then it is classified writable, not official', () => {
    const local = makeSkillRoot(['pentest-workflow'])
    const roots = resolvePersonalDirectiveSkillRoots({
      enabled: true,
      content: 'x',
      localSkillRootPath: local,
    })
    expect(roots.official).toEqual([])
    expect(roots.local).toEqual([local])
    expect(roots.all).toEqual([local])
  })

  test('Given both official and local roots Then official comes first so it wins name collisions', () => {
    const official = makeSkillRoot(['softseep'])
    const local = makeSkillRoot(['pentest-workflow'])
    const roots = resolvePersonalDirectiveSkillRoots({
      enabled: true,
      content: 'x',
      skillPaths: [official],
      localSkillRootPath: local,
    })
    expect(roots.all).toEqual([official, local])
  })

  test('Given a root listed as both official and local Then it stays only official (read-only wins)', () => {
    const root = makeSkillRoot(['softseep'])
    const roots = resolvePersonalDirectiveSkillRoots({
      enabled: true,
      content: 'x',
      skillPaths: [root],
      localSkillRootPath: root,
    })
    expect(roots.official).toEqual([root])
    expect(roots.local).toEqual([])
  })

  test('Given disabled Then no skill root is mounted even when configured', () => {
    const official = makeSkillRoot(['softseep'])
    const local = makeSkillRoot(['pentest-workflow'])
    const roots = resolvePersonalDirectiveSkillRoots({
      enabled: false,
      content: 'x',
      skillPaths: [official],
      localSkillRootPath: local,
    })
    expect(roots.all).toEqual([])
  })

  test('Given a missing skill root Then it is dropped instead of throwing', () => {
    const root = makeSkillRoot()
    const missing = join(root, 'nope')
    const roots = resolvePersonalDirectiveSkillRoots({ enabled: true, content: 'x', skillPaths: [missing] })
    expect(roots.all).toEqual([])
  })

  test('Given duplicate and blank entries Then they are collapsed', () => {
    const root = makeSkillRoot()
    const roots = resolvePersonalDirectiveSkillRoots({
      enabled: true,
      content: 'x',
      skillPaths: [root, ` ${root} `, '   '],
    })
    expect(roots.all).toEqual([root])
  })

  test('Given no personalDirective at all Then nothing is mounted', () => {
    expect(resolvePersonalDirectiveSkillRoots(undefined).all).toEqual([])
  })

  test('Given enabled with both root kinds Then the prompt labels each as read-only or writable', () => {
    const official = makeSkillRoot(['softseep', 'apkseep'])
    const local = makeSkillRoot(['pentest-workflow'])
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: 'PD_MARKER',
      skillPaths: [official],
      localSkillRootPath: local,
    })
    expect(prompt).toContain('破甲挂载的外部技能目录')
    expect(prompt).toContain('Seep 官方技能根（只读）')
    expect(prompt).toContain('本地技能源根（可写）')
    expect(prompt).toContain(official)
    expect(prompt).toContain(local)
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('不需要复制到工作区')
    // 官方根小节必须排在本地根之前，避免模型把两者混为一档。
    expect(prompt.indexOf('Seep 官方技能根（只读）')).toBeLessThan(prompt.indexOf('本地技能源根（可写）'))
  })

  test('Given only official roots Then no local section is emitted', () => {
    const official = makeSkillRoot(['softseep'])
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'PD_MARKER', skillPaths: [official] })
    expect(prompt).toContain('Seep 官方技能根（只读）')
    expect(prompt).not.toContain('本地技能源根（可写）')
  })

  test('Given only a local root Then no official section is emitted', () => {
    const local = makeSkillRoot(['pentest-workflow'])
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'PD_MARKER', localSkillRootPath: local })
    expect(prompt).toContain('本地技能源根（可写）')
    expect(prompt).not.toContain('Seep 官方技能根（只读）')
  })

  test('Given skill roots configured but directive disabled Then the prompt declares none', () => {
    const official = makeSkillRoot(['softseep'])
    const local = makeSkillRoot(['pentest-workflow'])
    const prompt = buildMinimalSystemPrompt({
      enabled: false,
      content: '',
      skillPaths: [official],
      localSkillRootPath: local,
    })
    expect(prompt).not.toContain('破甲挂载的外部技能目录')
    expect(prompt).not.toContain(official)
    expect(prompt).not.toContain(local)
  })

  test('Given enabled without skill roots Then no empty section is emitted', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'PD_MARKER' })
    expect(prompt).not.toContain('破甲挂载的外部技能目录')
  })
})

describe('seep system prompt layer (v1.8.2 architecture)', () => {
  test('Given a readable SYSTEM.md Then it is injected as a separate layer', () => {
    const path = writeDirectiveFile('SYSTEM.md', 'SEEP_DISCIPLINE_MARKER')
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: 'WIRING_MARKER',
      seepSystemPromptPath: path,
    })
    expect(prompt).toContain('### Seep 作战纪律（源自 Tool/prompts/SYSTEM.md，破甲开启时注入）')
    expect(prompt).toContain('SEEP_DISCIPLINE_MARKER')
    expect(prompt).toContain('### Proma 运行时接线（补充层）')
    expect(prompt).toContain('WIRING_MARKER')
  })

  test('Given both layers Then the adapter comes first, discipline second, wiring third', () => {
    const path = writeDirectiveFile('SYSTEM.md', 'SEEP_DISCIPLINE_MARKER')
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: 'WIRING_MARKER',
      seepSystemPromptPath: path,
    })
    const adapterAt = prompt.indexOf('Proma 适配层')
    const disciplineAt = prompt.indexOf('SEEP_DISCIPLINE_MARKER')
    const wiringAt = prompt.indexOf('WIRING_MARKER')
    expect(adapterAt).toBeGreaterThan(-1)
    expect(adapterAt).toBeLessThan(disciplineAt)
    expect(disciplineAt).toBeLessThan(wiringAt)
  })

  test('Given SYSTEM.md exists but wiring is empty Then the discipline layer still injects', () => {
    const path = writeDirectiveFile('SYSTEM.md', 'SEEP_DISCIPLINE_MARKER')
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: '',
      seepSystemPromptPath: path,
    })
    expect(prompt).toContain('SEEP_DISCIPLINE_MARKER')
    expect(prompt).toContain('Proma 适配层')
    expect(prompt).not.toContain('### Proma 运行时接线（补充层）')
  })

  test('Given only wiring and no SYSTEM.md path Then no discipline layer is emitted', () => {
    const prompt = buildMinimalSystemPrompt({ enabled: true, content: 'WIRING_MARKER' })
    expect(prompt).toContain('WIRING_MARKER')
    expect(prompt).not.toContain('### Seep 作战纪律（源自 Tool/prompts/SYSTEM.md，破甲开启时注入）')
  })

  test('Given a missing SYSTEM.md Then it is skipped without breaking the wiring layer', () => {
    const missing = join(tmpdir(), 'proma-seep-missing', 'SYSTEM.md')
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: 'WIRING_MARKER',
      seepSystemPromptPath: missing,
    })
    expect(prompt).toContain('WIRING_MARKER')
    expect(prompt).not.toContain('### Seep 作战纪律（源自 Tool/prompts/SYSTEM.md，破甲开启时注入）')
  })

  test('Given a blank SYSTEM.md Then it is skipped', () => {
    const path = writeDirectiveFile('blank-system.md', '   \n\n')
    const prompt = buildMinimalSystemPrompt({
      enabled: true,
      content: 'WIRING_MARKER',
      seepSystemPromptPath: path,
    })
    expect(prompt).not.toContain('### Seep 作战纪律（源自 Tool/prompts/SYSTEM.md，破甲开启时注入）')
    expect(prompt).toContain('WIRING_MARKER')
  })

  test('Given armor disabled Then SYSTEM.md is not read at all', () => {
    const path = writeDirectiveFile('SYSTEM.md', 'SEEP_DISCIPLINE_MARKER')
    const prompt = buildMinimalSystemPrompt({
      enabled: false,
      content: '',
      seepSystemPromptPath: path,
    })
    expect(prompt).not.toContain('SEEP_DISCIPLINE_MARKER')
    expect(prompt).not.toContain('### Seep 作战纪律（源自 Tool/prompts/SYSTEM.md，破甲开启时注入）')
  })

  test('Given resolveSeepSystemPrompt is called while disabled Then it returns undefined', () => {
    const path = writeDirectiveFile('SYSTEM.md', 'SEEP_DISCIPLINE_MARKER')
    expect(resolveSeepSystemPrompt({ enabled: false, content: '', seepSystemPromptPath: path })).toBeUndefined()
  })

  test('Given resolveSeepSystemPrompt with a valid file Then it returns trimmed content', () => {
    const path = writeDirectiveFile('SYSTEM.md', '  SEEP_BODY  \n')
    expect(resolveSeepSystemPrompt({ enabled: true, content: '', seepSystemPromptPath: path })).toBe('SEEP_BODY')
  })
})
