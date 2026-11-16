import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RETIRED_DEFAULT_SKILL_SLUGS, isRetiredDefaultSkill, removeRetiredDefaultSkills } from './config-paths'

describe('退役默认 Skill 清理', () => {
  test('Given 已知退役清单 When 查询 Then 包含已下线能力', () => {
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('brainstorming')
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('vault')
    // 0.19.78-01 / 0.20.0-07：Chat 退役后 tool-builder 指向的能力已移除。
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('tool-builder')
    // 生图按 Proma 账户余额计费，默认能力已下线。
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('proma-gpt-image-25')
  })

  test('Given 非退役 slug When 判断 Then false，不误删用户自装 Skill', () => {
    expect(isRetiredDefaultSkill('tool-builder')).toBe(true)
    expect(isRetiredDefaultSkill('proma-gpt-image-25')).toBe(true)
    expect(isRetiredDefaultSkill('docx')).toBe(false)
    expect(isRetiredDefaultSkill('my-own-skill')).toBe(false)
  })

  test('Given 目录内同时存在退役与保留 Skill When 清理 Then 只删退役的', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-retired-'))
    try {
      for (const slug of ['tool-builder', 'brainstorming', 'docx', 'proma-gpt-image-25']) {
        mkdirSync(join(dir, slug), { recursive: true })
        writeFileSync(join(dir, slug, 'SKILL.md'), `---\nname: ${slug}\n---\n`, 'utf8')
      }
      removeRetiredDefaultSkills(dir)
      expect(existsSync(join(dir, 'tool-builder'))).toBe(false)
      expect(existsSync(join(dir, 'brainstorming'))).toBe(false)
      expect(existsSync(join(dir, 'proma-gpt-image-25'))).toBe(false)
      expect(existsSync(join(dir, 'docx'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 退役目录不存在 When 清理 Then 不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-retired-empty-'))
    try {
      expect(() => removeRetiredDefaultSkills(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
