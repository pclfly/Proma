/** 推理能力配置服务：v1 合并覆盖，v2 保存完整列表（包括删除后的空列表）。 */
import { readFileSync, existsSync } from 'node:fs'
import {
  ALL_THINKING_LEVELS,
  getDefaultReasoningProfileConfigData,
  setReasoningProfileConfig,
  type ReasoningProfilesConfig,
  type ReasoningProfileConfigData,
} from '@proma/shared'
import { getReasoningProfilesPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

const CONFIG_VERSION = 2

/** v1 设置页保存过的内置规则；仅匹配未改动的规则时升级，不覆盖用户规则。 */
const LEGACY_MATCH_RULES: Record<string, ReasoningProfileConfigData['matchRules']> = {
  'deepseek-v4-flash': [{ type: 'prefix', value: 'deepseek-v4-flash' }],
  'deepseek-v4-pro': [{ type: 'prefix', value: 'deepseek-v4-pro' }],
  'deepseek-flash': [{ type: 'exact', value: 'deepseek-flash' }],
  'glm-5.3': [{ type: 'exact', value: 'glm-5.3' }],
  'openai-reasoning-standard': [{ type: 'prefix', value: 'gpt-5' }, { type: 'regex', value: '^(?:o1|o3|o4)(?:-|$)' }],
  'openai-reasoning-max': [{ type: 'prefix', value: 'gpt-5.6' }],
  'openai-reasoning-astra': [{ type: 'exact', value: 'openai-reasoning-astra' }],
  'openai-reasoning-sol-luna': [{ type: 'exact', value: 'openai-reasoning-sol-luna' }],
}

function migrateLegacyProfile(profile: ReasoningProfileConfigData, defaults: ReasoningProfileConfigData[]): ReasoningProfileConfigData {
  const migrated = structuredClone(profile)
  // v1 UI 允许默认档位与 levels 不一致，旧 resolver 会自动收敛；先兼容再严格校验。
  const allowedLevels = Array.isArray(migrated.levels)
    ? migrated.levels.filter((level) => ALL_THINKING_LEVELS.includes(level)) : []
  migrated.levels = allowedLevels.length > 0 ? [...new Set(allowedLevels)]
    : [ALL_THINKING_LEVELS.includes(migrated.defaultLevel) ? migrated.defaultLevel : 'high']
  if (!migrated.levels.includes(migrated.defaultLevel)) migrated.defaultLevel = migrated.levels[0]!
  const legacyRules = LEGACY_MATCH_RULES[profile.id]
  const unchanged = legacyRules?.length === profile.matchRules.length && legacyRules.every((rule, i) =>
    rule.type === profile.matchRules[i]?.type && rule.value === profile.matchRules[i]?.value,
  )
  const current = defaults.find((entry) => entry.id === profile.id)
  if (unchanged && current) migrated.matchRules = current.matchRules
  // v1 的 off:null 曾代表关闭；迁移不能将其变成“off 不可选”而重新开启思考。
  for (const encoding of Object.values(migrated.encodings)) {
    if (encoding?.effortMap.off !== null || !migrated.levels.includes('off')) continue
    if (encoding.kind === 'openai-reasoning-effort') encoding.effortMap.off = 'none'
    else delete encoding.effortMap.off
  }
  return migrated
}

function validateProfiles(profiles: ReasoningProfileConfigData[]): void {
  if (!Array.isArray(profiles)) throw new Error('推理配置必须是 profile 列表')
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (!profile || typeof profile.id !== 'string' || !profile.id.trim()) throw new Error('profile ID 不能为空')
    if (ids.has(profile.id)) throw new Error(`profile ID 重复：${profile.id}`)
    ids.add(profile.id)
    if (typeof profile.reasoning !== 'boolean'
      || !Array.isArray(profile.levels) || profile.levels.length === 0
      || profile.levels.some((level) => !ALL_THINKING_LEVELS.includes(level))
      || !profile.levels.includes(profile.defaultLevel)) throw new Error(`${profile.id} 的思考档位或默认值无效`)
    if (!Array.isArray(profile.matchRules) || profile.matchRules.some((rule) =>
      !rule || !['prefix', 'exact', 'regex'].includes(rule.type) || typeof rule.value !== 'string' || !rule.value.trim(),
    )) throw new Error(`${profile.id} 的模型匹配规则无效`)
    for (const rule of profile.matchRules) {
      if (rule.type === 'regex') {
        try { new RegExp(rule.value, 'i') } catch { throw new Error(`${profile.id} 的正则表达式无效`) }
      }
    }
    if (!profile.encodings || typeof profile.encodings !== 'object') throw new Error(`${profile.id} 的协议配置无效`)
    for (const [transport, encoding] of Object.entries(profile.encodings)) {
      if (!['anthropic-messages', 'openai-completions', 'openai-responses', 'other'].includes(transport)
        || !encoding || !['adaptive-effort', 'deepseek-output-effort', 'openai-reasoning-effort', 'zai-thinking-effort'].includes(encoding.kind)
        || !encoding.effortMap || typeof encoding.effortMap !== 'object'
        || Object.entries(encoding.effortMap).some(([level, value]) =>
          !ALL_THINKING_LEVELS.some((allowed) => allowed === level) || (value !== null && typeof value !== 'string'),
        )) throw new Error(`${profile.id} 的协议映射无效`)
    }
  }
}

/** path 参数仅用于隔离测试；生产调用统一由 config-paths 定位配置。 */
export function getMergedReasoningProfiles(filePath = getReasoningProfilesPath()): ReasoningProfileConfigData[] {
  const defaults = getDefaultReasoningProfileConfigData()
  if (!existsSync(filePath)) return defaults
  try {
    const config = JSON.parse(readFileSync(filePath, 'utf-8')) as ReasoningProfilesConfig
    if (config.version === CONFIG_VERSION) {
      validateProfiles(config.profiles)
      return config.profiles
    }
    // 历史配置只记录覆盖；不能把旧文件中缺少的条目误判成用户已删除。
    if (config.version !== 1 || !Array.isArray(config.profiles)) throw new Error('不支持的推理配置版本')
    const migrated = config.profiles.map((profile) => migrateLegacyProfile(profile, defaults))
    validateProfiles(migrated)
    const overrides = new Map(migrated.map((profile) => [profile.id, profile]))
    return [
      ...defaults.map((profile) => overrides.get(profile.id) ?? profile),
      ...migrated.filter((profile) => !defaults.some((def) => def.id === profile.id)),
    ]
  } catch (error) {
    console.error('[推理配置] 读取失败，使用内置默认:', error)
    return defaults
  }
}

export function syncReasoningProfileConfig(): ReasoningProfileConfigData[] {
  const profiles = getMergedReasoningProfiles()
  setReasoningProfileConfig(profiles, { authoritative: true })
  return profiles
}

export function writeReasoningProfiles(profiles: ReasoningProfileConfigData[], filePath = getReasoningProfilesPath()): void {
  validateProfiles(profiles)
  const config: ReasoningProfilesConfig = { version: CONFIG_VERSION, profiles }
  writeJsonFileAtomic(filePath, config)
}

/** [] 是删除全部；只有 null 明确表示恢复默认。先落盘成功，再更新当前进程。 */
export function updateReasoningProfiles(
  profiles: ReasoningProfileConfigData[] | null,
  filePath = getReasoningProfilesPath(),
): ReasoningProfileConfigData[] {
  const next = profiles === null ? getDefaultReasoningProfileConfigData() : profiles
  writeReasoningProfiles(next, filePath)
  setReasoningProfileConfig(next, { authoritative: true })
  return next
}
