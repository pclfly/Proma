/**
 * 推理能力配置服务
 *
 * 管理模型推理能力配置（levels / thinkingLevelMap / reasoning / 模型匹配规则）的读写，
 * 并注入到 @proma/shared 的 resolveReasoningProfile，供主进程与渲染进程共用。
 *
 * 存储位置：~/.proma/reasoning-profiles.json
 *
 * 合并策略：内置默认 profile（来自 shared 的 getDefaultReasoningProfileConfigData）
 * + 用户自定 profile。用户按 id 覆盖同名内置 profile，新增 id 追加。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  getDefaultReasoningProfileConfigData,
  setReasoningProfileConfig,
  type ReasoningProfilesConfig,
  type ReasoningProfileConfigData,
} from '@proma/shared'
import { getReasoningProfilesPath } from './config-paths'

const CONFIG_VERSION = 1

/** 读取配置文件中的用户 profile 列表。返回 null 表示文件不存在。 */
function readUserProfiles(): ReasoningProfileConfigData[] | null {
  const filePath = getReasoningProfilesPath()
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<ReasoningProfilesConfig>
    if (!Array.isArray(data.profiles)) return []
    return data.profiles.filter((profile) => profile && typeof profile.id === 'string')
  } catch (error) {
    console.error('[推理配置] 读取失败:', error)
    return []
  }
}

/**
 * 获取合并后的完整 profile 列表（内置默认 + 用户覆盖）。
 *
 * 用户 profile 按 id 覆盖内置同名 profile；内置但未覆盖的保留；
 * 仅用户新增的 id 追加到末尾。
 */
export function getMergedReasoningProfiles(): ReasoningProfileConfigData[] {
  const defaults = getDefaultReasoningProfileConfigData()
  const userProfiles = readUserProfiles()
  if (!userProfiles || userProfiles.length === 0) return defaults

  const merged: ReasoningProfileConfigData[] = []

  // 先处理内置默认，遇到用户覆盖则用用户版本替换
  for (const def of defaults) {
    const override = userProfiles.find((u) => u.id === def.id)
    merged.push(override ?? def)
  }
  // 追加用户新增的 id（不在内置默认里）
  for (const user of userProfiles) {
    if (!merged.some((m) => m.id === user.id)) merged.push(user)
  }
  return merged
}

/**
 * 把当前合并后的配置注入到 @proma/shared 的 resolveReasoningProfile。
 *
 * 同时返回合并结果供调用方（如 IPC）使用。
 */
export function syncReasoningProfileConfig(): ReasoningProfileConfigData[] {
  const merged = getMergedReasoningProfiles()
  setReasoningProfileConfig(merged)
  return merged
}

/**
 * 保存用户自定义 profile 列表到配置文件。
 *
 * 覆盖写入（不含内置默认），下次 getMerged 时再与内置合并。
 */
export function writeReasoningProfiles(profiles: ReasoningProfileConfigData[]): void {
  const filePath = getReasoningProfilesPath()
  const config: ReasoningProfilesConfig = {
    version: CONFIG_VERSION,
    profiles,
  }
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
    console.log('[推理配置] 已更新', profiles.length, '个 profile')
  } catch (error) {
    console.error('[推理配置] 写入失败:', error)
    throw new Error('写入推理能力配置失败')
  }
}

/**
 * 更新用户 profile 并重新注入。
 *
 * @param profiles 用户完整 profile 列表（保存到文件，再与内置合并注入）
 * @returns 合并后的完整 profile 列表
 */
export function updateReasoningProfiles(
  profiles: ReasoningProfileConfigData[],
): ReasoningProfileConfigData[] {
  writeReasoningProfiles(profiles)
  return syncReasoningProfileConfig()
}
