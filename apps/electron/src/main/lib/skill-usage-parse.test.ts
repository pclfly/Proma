import { describe, expect, test } from 'bun:test'
import { parseSkillActivations } from './skill-usage-parse'

const WORKSPACE_SKILLS_ROOT = 'C:\\Users\\tester\\.proma\\agent-workspaces\\demo-a\\skills'

function userText(text: string, timestamp?: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(timestamp ? { timestamp } : {}),
  }
}

function userWithActivations(
  activations: unknown[],
  timestamp?: string,
): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text: '展开 Skill' }] },
    parent_tool_use_id: null,
    skill_activations: activations,
    ...(timestamp ? { timestamp } : {}),
  }
}

function assistantText(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

function assistantRead(toolUseId: string, filePath: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: filePath } },
      ],
    },
    parent_tool_use_id: null,
  }
}

function toolResult(toolUseId: string, isError = false): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError },
      ],
    },
    parent_tool_use_id: null,
  }
}

function resultWithActivations(activations: unknown[]): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    skill_activations: activations,
  }
}

function workspaceActivation(slug: string, name: string, workspaceSlug = 'demo-a'): Record<string, unknown> {
  return {
    slug,
    name,
    workspaceSlug,
    workspaceSkillPath: `${slug}/SKILL.md`,
    sources: ['explicit'],
  }
}

describe('Skill 激活解析', () => {
  test('Given 消息带有结构化 skill_activations When 解析 Then 计入真实激活', () => {
    const records = parseSkillActivations(
      [userWithActivations([workspaceActivation('demo', 'Demo Skill')])],
      { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 1000 },
    )

    expect(records).toEqual([
      { skillPath: 'demo/SKILL.md', skillName: 'Demo Skill', activatedAt: 1000 },
    ])
  })

  test('Given 正文只提到 Skill 名称或手写 skill 标签 When 解析 Then 不计入使用', () => {
    const records = parseSkillActivations([
      userText('请使用 demo skill，参考 skills/demo/SKILL.md，注意这不是激活。'),
      assistantText('<skill name="demo" location="C:/tmp/skills/demo/SKILL.md">正文</skill>'),
      resultWithActivations([]),
    ], { sessionActivityAt: 1000 })

    expect(records).toEqual([])
  })

  test('Given 成功读取工作区 SKILL.md When 没有元数据 Then Read 回退计入一次', () => {
    const entryPath = `${WORKSPACE_SKILLS_ROOT}\\demo\\SKILL.md`
    const records = parseSkillActivations(
      [assistantRead('tool-1', entryPath), toolResult('tool-1')],
      { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 2000 },
    )

    expect(records).toEqual([
      { skillPath: 'demo/SKILL.md', skillName: 'demo', activatedAt: 2000 },
    ])
  })

  test('Given 读取 SKILL.md 失败 When 解析 Then 不计入使用', () => {
    const entryPath = `${WORKSPACE_SKILLS_ROOT}\\demo\\SKILL.md`
    const records = parseSkillActivations(
      [assistantRead('tool-1', entryPath), toolResult('tool-1', true)],
      { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 2000 },
    )

    expect(records).toEqual([])
  })

  test('Given 同一 Skill 既有元数据又有成功 Read When 解析 Then 只计一次', () => {
    const entryPath = `${WORKSPACE_SKILLS_ROOT}\\demo\\SKILL.md`
    const records = parseSkillActivations([
      userWithActivations([workspaceActivation('demo', 'Demo Skill')]),
      assistantRead('tool-1', entryPath),
      toolResult('tool-1'),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 3000 })

    expect(records).toHaveLength(1)
    expect(records[0]?.skillPath).toBe('demo/SKILL.md')
  })

  test('Given 多个 result 重复累计同一 Skill When 没有 user 元数据 Then 每会话只计一次', () => {
    const activation = workspaceActivation('demo', 'Demo Skill')
    const records = parseSkillActivations([
      resultWithActivations([activation]),
      resultWithActivations([activation]),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 4000 })

    expect(records).toHaveLength(1)
    expect(records[0]?.activatedAt).toBe(4000)
  })

  test('Given 多条 user 消息分别激活同一 Skill When 解析 Then 每次使用都计数', () => {
    const records = parseSkillActivations([
      userWithActivations([workspaceActivation('demo', 'Demo Skill')], '2026-01-01T00:00:00.000Z'),
      userWithActivations([workspaceActivation('demo', 'Demo Skill')]),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 9000 })

    expect(records).toHaveLength(2)
    expect(records.map((record) => record.activatedAt)).toEqual([
      Date.parse('2026-01-01T00:00:00.000Z'),
      9000,
    ])
  })

  test('Given 激活来自其它工作区 When 指定当前工作区 Then 同名 Skill 不混入', () => {
    const otherRoot = 'C:\\Users\\tester\\.proma\\agent-workspaces\\demo-b\\skills'
    const records = parseSkillActivations([
      userWithActivations([workspaceActivation('demo', 'Demo Skill', 'demo-b')]),
      userWithActivations([{
        slug: 'demo',
        name: 'Demo Skill',
        filePath: `${otherRoot}\\demo\\SKILL.md`,
        sources: ['read'],
      }]),
      userWithActivations([{
        slug: 'demo',
        name: 'Demo Skill',
        workspaceSlug: 'demo-b',
        sources: ['explicit'],
      }]),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 1000 })

    expect(records).toEqual([])
  })

  test('Given 激活路径位于工作区外部的额外 Skill 根 When 指定工作区 Then 不计入', () => {
    const records = parseSkillActivations([
      userWithActivations([{
        slug: 'demo',
        name: 'Demo Skill',
        filePath: 'C:\\Tools\\seep\\skills\\demo\\SKILL.md',
        sources: ['read'],
      }]),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 1000 })

    expect(records).toEqual([])
  })

  test('Given 损坏消息与损坏激活条目 When 解析 Then 跳过且保留有效记录', () => {
    const records = parseSkillActivations([
      null,
      'broken line',
      42,
      { type: 'user', message: null, parent_tool_use_id: null },
      { type: 'assistant', parent_tool_use_id: null },
      { type: 'user', parent_tool_use_id: null, skill_activations: 'not-an-array' },
      userWithActivations([{}, { slug: '' }, { name: '缺少 slug' }]),
      userWithActivations([workspaceActivation('demo', 'Demo Skill')]),
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 7000 })

    expect(records).toEqual([
      { skillPath: 'demo/SKILL.md', skillName: 'Demo Skill', activatedAt: 7000 },
    ])
  })

  test('Given Read 回退消息含有损坏内容块 When 解析 Then 跳过损坏块并保留有效读取', () => {
    const entryPath = `${WORKSPACE_SKILLS_ROOT}\\demo\\SKILL.md`
    const records = parseSkillActivations([
      {
        type: 'assistant',
        message: {
          content: [
            null,
            'broken block',
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: entryPath } },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: {
          content: [
            null,
            { type: 'tool_result', tool_use_id: 'tool-1' },
          ],
        },
        parent_tool_use_id: null,
      },
    ], { workspaceSlug: 'demo-a', workspaceSkillsRoot: WORKSPACE_SKILLS_ROOT, sessionActivityAt: 2500 })

    expect(records).toEqual([
      { skillPath: 'demo/SKILL.md', skillName: 'demo', activatedAt: 2500 },
    ])
  })

  test('Given 不提供工作区上下文 When 解析托管工作区激活 Then 使用相对路径作为统计键', () => {
    const records = parseSkillActivations([
      userWithActivations([workspaceActivation('demo', 'Demo Skill')]),
    ])

    expect(records).toEqual([
      { skillPath: 'demo/SKILL.md', skillName: 'Demo Skill', activatedAt: 0 },
    ])
  })
})
