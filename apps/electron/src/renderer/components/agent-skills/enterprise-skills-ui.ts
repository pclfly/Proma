/**
 * 企业 Skills 列表的纯展示逻辑：合并库条目、已安装版本与更新检查结果。
 */

import type {
  EnterpriseSkillLibraryItem,
  EnterpriseSkillUpdateEntry,
  EnterpriseSkillsAvailability,
  SkillMeta,
} from '@proma/shared'

export interface EnterpriseSkillRow {
  id: string
  slug: string
  name: string
  description: string
  enterpriseId?: string
  latestVersion: EnterpriseSkillLibraryItem['latestVersion']
  installedVersion: string | null
  updateAvailable: boolean
  action: 'install' | 'update' | 'installed'
}

export function buildEnterpriseSkillRows(
  items: readonly EnterpriseSkillLibraryItem[],
  installedSkills: readonly SkillMeta[],
  updates: readonly EnterpriseSkillUpdateEntry[],
): EnterpriseSkillRow[] {
  const installedBySkillId = new Map<string, SkillMeta>()
  for (const skill of installedSkills) {
    if (skill.enterpriseSource) installedBySkillId.set(skill.enterpriseSource.skillId, skill)
  }
  const updateIds = new Set(updates.map((entry) => entry.skillId))

  return items.map((item) => {
    const installed = installedBySkillId.get(item.id)
    const source = installed?.enterpriseSource
    const updateAvailable = Boolean(source) && (
      updateIds.has(item.id)
      || source?.versionId !== item.latestVersion.id
    )
    return {
      id: item.id,
      slug: item.slug,
      name: item.name?.trim() || item.slug,
      description: item.description?.trim() || '',
      ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
      latestVersion: item.latestVersion,
      installedVersion: source?.installedVersion ?? null,
      updateAvailable,
      action: !source ? 'install' : updateAvailable ? 'update' : 'installed',
    }
  })
}

export function countInstalledEnterpriseSkills(skills: readonly SkillMeta[]): number {
  return skills.filter((skill) => Boolean(skill.enterpriseSource)).length
}

export interface EnterpriseSkillsAvailabilityNotice {
  tone: 'ready' | 'unavailable'
  message: string
}

export function describeEnterpriseSkillsAvailability(
  availability: EnterpriseSkillsAvailability,
): EnterpriseSkillsAvailabilityNotice {
  if (availability.enabled) {
    return { tone: 'ready', message: '企业库已连接' }
  }
  return {
    tone: 'unavailable',
    message: availability.reason?.trim() || '企业 Skills 服务尚未接入',
  }
}
