import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProtectedSkillWriteMessage, matchProtectedSkillWrite } from './agent-personal-directive-skill-guard'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 建一个技能根，内含一个 SKILL.md。 */
function makeSkillRoot(): string {
  const root = makeTempDir('proma-guard-skill-')
  writeFileSync(join(root, 'SKILL.md'), '---\nname: demo\n---\n', 'utf-8')
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('protected skill write detection', () => {
  test('Given Write targets a file inside a skill root Then it is matched', () => {
    const root = makeSkillRoot()
    const hit = matchProtectedSkillWrite('Write', { file_path: join(root, 'SKILL.md') }, [root])
    expect(hit).toBe(root)
  })

  test('Given Edit targets a nested script in the skill root Then it is matched', () => {
    const root = makeSkillRoot()
    mkdirSync(join(root, 'scripts'))
    const hit = matchProtectedSkillWrite('Edit', { file_path: join(root, 'scripts', 'start.ps1') }, [root])
    expect(hit).toBe(root)
  })

  test('Given NotebookEdit targets the skill root Then it is matched', () => {
    const root = makeSkillRoot()
    const hit = matchProtectedSkillWrite('NotebookEdit', { file_path: join(root, 'x.ipynb') }, [root])
    expect(hit).toBe(root)
  })

  test('Given a relative path Then it is ignored so the adapter-normalized absolute path decides', () => {
    const root = makeSkillRoot()
    expect(matchProtectedSkillWrite('Write', { file_path: 'SKILL.md' }, [root])).toBeUndefined()
  })

  test('Given the target is outside every skill root Then it is not matched', () => {
    const root = makeSkillRoot()
    const outside = makeTempDir('proma-guard-outside-')
    expect(matchProtectedSkillWrite('Write', { file_path: join(outside, 'notes.md') }, [root])).toBeUndefined()
  })

  test('Given a sibling directory sharing the root prefix Then it is not matched', () => {
    const root = makeSkillRoot()
    const sibling = `${root}-other`
    mkdirSync(sibling, { recursive: true })
    tempDirs.push(sibling)
    expect(matchProtectedSkillWrite('Write', { file_path: join(sibling, 'SKILL.md') }, [root])).toBeUndefined()
  })

  test('Given a path traversal that climbs out of the root Then it is not matched', () => {
    const root = makeSkillRoot()
    const outside = join(root, '..', 'escaped.md')
    expect(matchProtectedSkillWrite('Write', { file_path: outside }, [root])).toBeUndefined()
  })

  test('Given a symlink inside the root pointing outside Then the real target decides', () => {
    const root = makeSkillRoot()
    const outside = makeTempDir('proma-guard-link-target-')
    const outsideFile = join(outside, 'passwd.md')
    writeFileSync(outsideFile, 'x', 'utf-8')
    const linkPath = join(root, 'link.md')
    try {
      symlinkSync(outsideFile, linkPath, 'file')
    } catch {
      return // 无权限建符号链接（Windows 非管理员）时跳过
    }
    expect(matchProtectedSkillWrite('Write', { file_path: linkPath }, [root])).toBeUndefined()
  })

  test('Given a non-write tool Then it never matches', () => {
    const root = makeSkillRoot()
    const target = join(root, 'SKILL.md')
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Skill']) {
      expect(matchProtectedSkillWrite(tool, { file_path: target }, [root])).toBeUndefined()
    }
  })

  test('Given no skill roots configured Then nothing is protected', () => {
    const root = makeSkillRoot()
    expect(matchProtectedSkillWrite('Write', { file_path: join(root, 'SKILL.md') }, [])).toBeUndefined()
  })

  test('Given input carries path instead of file_path Then it still matches', () => {
    const root = makeSkillRoot()
    expect(matchProtectedSkillWrite('Write', { path: join(root, 'SKILL.md') }, [root])).toBe(root)
  })
})

describe('protected skill write message', () => {
  test('Given a denial Then the message names the root, the tool and the writable sink', () => {
    const message = buildProtectedSkillWriteMessage('D:\\skills\\softseep', 'Write', 'D:\\local-skills')
    expect(message).toContain('Seep 官方技能目录为只读')
    expect(message).toContain('D:\\skills\\softseep')
    expect(message).toContain('Write')
    expect(message).toContain('D:\\local-skills')
    expect(message).toContain('包括用户逐次授权')
    expect(message).toContain('不要换个写法')
  })

  test('Given no local root Then the message falls back to the workspace skills sink', () => {
    const message = buildProtectedSkillWriteMessage('D:\\skills\\softseep', 'Edit')
    expect(message).toContain('Proma 工作区 skills/')
  })
})

describe('local skill root stays writable', () => {
  test('Given a write under the local root Then it is not matched as official', () => {
    const official = makeSkillRoot()
    const local = makeSkillRoot()
    mkdirSync(join(local, 'my-new-skill'), { recursive: true })
    const target = join(local, 'my-new-skill', 'SKILL.md')
    expect(matchProtectedSkillWrite('Write', { file_path: target }, [official])).toBeUndefined()
  })

  test('Given an official root nested under the local root Then the official root still blocks', () => {
    const local = makeSkillRoot()
    const official = join(local, 'official')
    mkdirSync(official, { recursive: true })
    writeFileSync(join(official, 'SKILL.md'), '---\nname: x\n---\n', 'utf-8')
    expect(matchProtectedSkillWrite('Write', { file_path: join(official, 'SKILL.md') }, [official])).toBe(official)
  })
})
