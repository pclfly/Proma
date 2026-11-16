import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnterpriseSkillLibraryItem, SkillMeta } from '@proma/shared'
import {
  buildEnterpriseSkillRows,
  countInstalledEnterpriseSkills,
  describeEnterpriseSkillsAvailability,
} from './enterprise-skills-ui'

const item: EnterpriseSkillLibraryItem = {
  id: 'skill-1',
  slug: 'release-notes',
  name: 'Release Notes',
  description: '生成发布说明',
  enterpriseId: 'ent-1',
  latestVersion: { id: 'v2', version: '2.0.0', artifactSha256: 'a'.repeat(64) },
}

function installed(versionId: string): SkillMeta {
  return {
    slug: 'release-notes',
    name: 'Release Notes',
    enabled: true,
    enterpriseSource: {
      schemaVersion: 2,
      type: 'enterprise-library',
      enterpriseId: 'ent-1',
      skillId: 'skill-1',
      versionId,
      installedVersion: versionId === 'v2' ? '2.0.0' : '1.0.0',
      artifactSha256: 'b'.repeat(64),
      baseManifestSha256: 'c'.repeat(64),
      installedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

describe('企业 Skills 列表展示', () => {
  test('Given 未安装 When 合并 Then 显示安装动作', () => {
    const rows = buildEnterpriseSkillRows([item], [], [])
    expect(rows[0]).toMatchObject({
      id: 'skill-1',
      name: 'Release Notes',
      installedVersion: null,
      action: 'install',
      updateAvailable: false,
    })
  })

  test('Given 已安装同版本 When 合并 Then 显示已安装', () => {
    const rows = buildEnterpriseSkillRows([item], [installed('v2')], [])
    expect(rows[0]?.action).toBe('installed')
    expect(rows[0]?.installedVersion).toBe('2.0.0')
  })

  test('Given 更新检查返回新版本 When 合并 Then 显示更新动作', () => {
    const rows = buildEnterpriseSkillRows([item], [installed('v1')], [{ skillId: 'skill-1' }])
    expect(rows[0]?.action).toBe('update')
    expect(rows[0]?.updateAvailable).toBe(true)
  })

  test('Given 本地版本落后但未检查 When 合并 Then 仍提示可更新', () => {
    const rows = buildEnterpriseSkillRows([item], [installed('v1')], [])
    expect(rows[0]?.action).toBe('update')
  })

  test('Given 本地 Skill 混合 When 统计 Then 只数企业来源', () => {
    expect(countInstalledEnterpriseSkills([
      installed('v1'),
      { slug: 'local', name: 'Local', enabled: true },
    ])).toBe(1)
  })

  test('Given 云端不可用 When 描述 Then 展示原因', () => {
    expect(describeEnterpriseSkillsAvailability({ enabled: false, reason: '未登录' }))
      .toEqual({ tone: 'unavailable', message: '未登录' })
    expect(describeEnterpriseSkillsAvailability({ enabled: true }))
      .toEqual({ tone: 'ready', message: '企业库已连接' })
  })
})

describe('企业 Skills 页面接线', () => {
  const rendererRoot = join(import.meta.dir, '..', '..')
  const read = (relativePath: string): string =>
    readFileSync(join(rendererRoot, relativePath), 'utf8').replaceAll(String.fromCharCode(13), '')

  test('Given Skills 页 When 挂载 Then 渲染企业 Skills 区块', () => {
    const view = read('components/agent-skills/AgentSkillsView.tsx')
    expect(view).toContain("import { EnterpriseSkillsSection } from './EnterpriseSkillsSection'")
    expect(view).toContain('<EnterpriseSkillsSection')
  })

  test('Given 企业区块 When 操作 Then 消费列表/安装/更新检查接口', () => {
    const section = read('components/agent-skills/EnterpriseSkillsSection.tsx')
    expect(section).toContain('listEnterpriseSkills()')
    expect(section).toContain('installEnterpriseSkill(workspaceSlug')
    expect(section).toContain('checkEnterpriseSkillUpdates(')
  })
})
