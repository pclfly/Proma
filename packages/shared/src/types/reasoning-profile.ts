import type { ProviderType } from './channel'
import type { AgentThinkingLevel } from './agent'

/**
 * 用户可自定义的 profile id 形式。内置 id 保持原有字面量，
 * 用户通过配置文件可新增任意 id，故放宽为 string。
 */
export type ReasoningProfileId = string

/** Proma 可识别的 reasoning 请求协议族。 */
export type ReasoningTransport =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'other'

/**
 * 将渠道归类到其实际的 reasoning 请求协议。
 *
 * 渠道名不能直接决定请求字段；profile 必须同时匹配模型 ID 和 transport，
 * 才能避免把 OpenAI 的 reasoning_effort 发送到 Anthropic endpoint。
 */
export function inferReasoningTransport(provider: ProviderType | undefined): ReasoningTransport {
  switch (provider) {
    case 'openai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'doubao-api':
    case 'qwen':
    case 'custom':
      return 'openai-completions'
    case 'openai-codex':
    case 'openai-responses':
    case 'xai':
      return 'openai-responses'
    case 'google':
      return 'other'
    default:
      return 'anthropic-messages'
  }
}

/** 编译器据此生成 runtime 专属请求参数。 */
export type ReasoningEncodingKind =
  | 'adaptive-effort'
  | 'deepseek-output-effort'
  | 'openai-reasoning-effort'
  | 'zai-thinking-effort'

/** 每个产品等级映射为目标协议可接受的 effort 值。 */
export type ReasoningEffortMap = Partial<Record<AgentThinkingLevel, string | null>>

export interface ReasoningEncoding {
  kind: ReasoningEncodingKind
  effortMap: ReasoningEffortMap
}

export interface ReasoningProfile {
  id: ReasoningProfileId
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  normalize(level: AgentThinkingLevel | undefined): AgentThinkingLevel
  encodings: Partial<Record<ReasoningTransport, ReasoningEncoding>>
  /** 模型是否支持思考。缺省 true；配置为 false 时该 profile 视为不支持思考。 */
  reasoning?: boolean
}

/** Pi model catalog 中与会话级 reasoning 选择有关的最小元数据。 */
export interface PiCatalogReasoningMetadata {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>
}

/**
 * 可跨主进程和渲染进程传输的 reasoning capability。
 *
 * 不携带 protocol encoding；Pi catalog 继续负责把所选 level 编码为实际请求字段。
 */
export interface ReasoningCapability {
  source: 'profile' | 'pi-catalog'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
}

export interface ResolveReasoningCapabilityInput {
  profile?: ReasoningProfile
  catalog?: PiCatalogReasoningMetadata
}

export interface ResolveReasoningProfileInput {
  modelId: string | undefined
  transport: ReasoningTransport
}

/**
 * 模型命中规则的匹配方式。
 *
 * profile 通过这些规则命中具体模型，规则按数组顺序逐个尝试，
 * 命中即返回。
 */
export type ReasoningMatchRuleType =
  | 'prefix'   // 模型 id 以前缀匹配
  | 'exact'    // 模型 id 完全等于 value
  | 'regex'    // 模型 id 匹配 value 正则（仅主进程/已验证场景建议使用）

/** 单条模型匹配规则。 */
export interface ReasoningMatchRule {
  /** 匹配方式 */
  type: ReasoningMatchRuleType
  /** 匹配值：前缀/精确串，或正则表达式
   *（正则需注意跨进程可控性，建议优先 prefix/exact） */
  value: string
}

/**
 * 可持久化到 ~/.proma/reasoning-profiles.json 的 profile 数据。
 *
 * 与运行时 ReasoningProfile 不同，本结构**完全可 JSON 序列化**：
 * normalize 行为被降级为 levels/defaultLevel，由共享层通用规则重建；
 * encodings 中的 effortMap 即为用户可改的 thinkingLevelMap。
 */
export interface ReasoningProfileConfigData {
  /** profile 唯一 id（与运行时 ReasoningProfile.id 对应） */
  id: ReasoningProfileId
  /** 档位集合
   *（所有可用档位，如 ["off","low","high","xhigh","max"]） */
  levels: AgentThinkingLevel[]
  /** 默认档位 */
  defaultLevel: AgentThinkingLevel
  /** 模型是否支持思考（reasoning 标志） */
  reasoning: boolean
  /** 模型匹配规则数组，命中该 profile 即应用其档位配置 */
  matchRules: ReasoningMatchRule[]
  /** 各 transport 协议的编码（含 effortMap，即 thinkingLevelMap） */
  encodings: Partial<Record<ReasoningTransport, {
    kind: ReasoningEncodingKind
    effortMap: ReasoningEffortMap
  }>>
}

/** 推理能力配置文件格式。 */
export interface ReasoningProfilesConfig {
  /** 配置版本号 */
  version: number
  /** 用户自定义 profile 列表（与内置默认按 id 合并，用户覆盖同名 id） */
  profiles: ReasoningProfileConfigData[]
}

const DEEPSEEK_V4_LEVELS = ['off', 'low', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
const K3_LEVELS = ['off', 'low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_52_LEVELS = ['off', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_53_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
/**
 * GLM-5.3 强制开启思考，深度由 reasoning_effort / output_config.effort 控制。
 * Coding Plan 会把历史开关输入映射为 low，故不向运行时暴露 off。
 */
const GLM_53_EFFORT_MAP: ReasoningEffortMap = {
  low: 'low',
  high: 'high',
  max: 'max',
}
const OPENAI_STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, 'max'] as const satisfies readonly AgentThinkingLevel[]

// DeepSeek Anthropic compatibility only honors output_config.effort. The official
// V4 Flash and Pro mappings differ at low and xhigh; off is handled by emitting
// `thinking: { type: 'disabled' }` rather than an effort value.
const DEEPSEEK_V4_FLASH_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'high',
  max: 'max',
}
const DEEPSEEK_V4_PRO_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: null,
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const K3_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_OPENAI_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_ANTHROPIC_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'high',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// Pi uses this sparse map as an override for its native level mapping. In particular,
// off must become none because OpenAI reasoning models otherwise default to medium.
const OPENAI_STANDARD_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  xhigh: 'xhigh',
}
const OPENAI_MAX_EFFORT_MAP: ReasoningEffortMap = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: 'max',
}

function normalizeDeepSeekV4Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeK3Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeGlm52Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  return level === 'xhigh' || level === 'max' ? 'max' : 'high'
}

function normalizeGlm53Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'minimal':
    case 'low':
    case 'off':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'max'
  }
}

function normalizeOpenAIStandardLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  if (level === 'minimal') return 'low'
  if (level === 'max') return 'xhigh'
  return level ?? 'high'
}

function normalizeOpenAIMaxLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'minimal') return 'low'
  return level ?? 'high'
}

const DEEPSEEK_V4_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_V4_PRO_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-pro',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_PRO_EFFORT_MAP },
  },
}

const K3_PROFILE: ReasoningProfile = {
  id: 'kimi-k3',
  levels: K3_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeK3Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_EFFORT_MAP },
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_EFFORT_MAP },
  },
}

const GLM_53_PROFILE: ReasoningProfile = {
  id: 'glm-5.3',
  levels: GLM_53_LEVELS,
  defaultLevel: 'max',
  normalize: normalizeGlm53Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_53_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_53_EFFORT_MAP },
  },
}

const GLM_52_PROFILE: ReasoningProfile = {
  id: 'glm-5.2',
  levels: GLM_52_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm52Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_52_ANTHROPIC_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_52_OPENAI_EFFORT_MAP },
  },
}

const OPENAI_STANDARD_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-standard',
  levels: OPENAI_STANDARD_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
  },
}

const OPENAI_MAX_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-max',
  levels: OPENAI_MAX_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
  },
}

const OPENAI_ASTRA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-astra',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'low',
  normalize: (level) => level === 'off' || level === 'minimal' ? 'low' : level ?? 'low',
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_ASTRA_PROFILE,
]

/** 内置 profile 的缺省匹配规则（与 resolveReasoningProfile 的内置匹配逻辑一致）。 */
const BUILTIN_PROFILE_MATCH_RULES: Record<string, ReasoningMatchRule[]> = {
  'deepseek-v4-flash': [{ type: 'prefix', value: 'deepseek-v4-flash' }],
  'deepseek-v4-pro': [{ type: 'prefix', value: 'deepseek-v4-pro' }],
  'kimi-k3': [{ type: 'regex', value: '^(?:k3(?:-256k)?|kimi-k3)$' }],
  'glm-5.3': [{ type: 'exact', value: 'glm-5.3' }],
  'glm-5.2': [{ type: 'exact', value: 'glm-5.2' }],
  'openai-reasoning-standard': [{ type: 'prefix', value: 'gpt-5' }, { type: 'regex', value: '^(?:o1|o3|o4)(?:-|$)' }],
  'openai-reasoning-max': [{ type: 'prefix', value: 'gpt-5.6' }],
}

/**
 * 把内置硬编码 profile 转成可序列化的配置数据（供主进程作为默认基线）。
 *
 * 这样即使没有用户配置文件，UI 也能回显内置档位；用户配置按 id 覆盖后写入。
 */
export function getDefaultReasoningProfileConfigData(): ReasoningProfileConfigData[] {
  return REASONING_PROFILES.map((profile) => {
    const encodings: ReasoningProfileConfigData['encodings'] = {}
    for (const [transport, encoding] of Object.entries(profile.encodings)) {
      if (!encoding) continue
      encodings[transport as ReasoningTransport] = {
        kind: encoding.kind,
        effortMap: { ...encoding.effortMap },
      }
    }
    return {
      id: profile.id,
      levels: [...profile.levels],
      defaultLevel: profile.defaultLevel,
      reasoning: true,
      matchRules: BUILTIN_PROFILE_MATCH_RULES[profile.id] ?? [{ type: 'exact', value: profile.id }],
      encodings,
    }
  })
}

/** 仅按模型 ID 匹配，再以实际 transport 确认该模型是否有已验证的协议 encoding。
 *
 * 优先使用通过 setReasoningProfileConfig 注入的用户配置 profile（按 matchRules 命中）；
 * 未命中或未注入时回退到内置硬编码 profile，保证向后兼容。
 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  const modelId = input.modelId?.toLowerCase()
  if (!modelId) return undefined

  // 1) 用户注入配置优先：按 matchRules 命中即返回对应 profile（重建后带 normalize/encodings）
  const configuredProfile = resolveConfiguredProfileForModel(modelId, input.transport)
  if (configuredProfile) return configuredProfile

  // 2) 内置硬编码 profile（以下保持原逻辑）
  const isOpenAITransport = input.transport === 'openai-completions' || input.transport === 'openai-responses'
  const isOpenAIReasoningModel = !modelId.endsWith('-chat-latest')
    && (modelId.startsWith('gpt-5') || /^(o1|o3|o4)(?:-|$)/.test(modelId))
  if (modelId === 'gpt-6-astra') {
    return OPENAI_ASTRA_PROFILE.encodings[input.transport] ? OPENAI_ASTRA_PROFILE : undefined
  }
  const profile = /^deepseek-v4-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_V4_FLASH_PROFILE
    : /^deepseek-v4-pro(?:-|$)/.test(modelId)
      ? DEEPSEEK_V4_PRO_PROFILE
      : /^(?:k3(?:-256k)?|kimi-k3)$/.test(modelId)
        ? K3_PROFILE
        : modelId === 'glm-5.3' || modelId === 'glm-5.3-flash'
          ? GLM_53_PROFILE
          : modelId === 'glm-5.2'
            ? GLM_52_PROFILE
            : isOpenAITransport && isOpenAIReasoningModel
              ? /^gpt-5\.6(?:-|$)/.test(modelId) ? OPENAI_MAX_PROFILE : OPENAI_STANDARD_PROFILE
              : undefined

  return profile?.encodings[input.transport] ? profile : undefined
}

const PI_EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]

function getPiCatalogThinkingLevels(catalog: PiCatalogReasoningMetadata): AgentThinkingLevel[] {
  if (!catalog.reasoning) return []

  return PI_EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = catalog.thinkingLevelMap?.[level]
    if (mapped === null) return false
    // Pi only exposes these extended levels when the catalog maps them explicitly.
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined
  })
}

/**
 * 解析最终会话 capability。显式 profile 优先于 Pi catalog，保留经过验证的模型专属编码。
 */
export function resolveReasoningCapability(input: ResolveReasoningCapabilityInput): ReasoningCapability | undefined {
  if (input.profile) {
    // 配置的 reasoning=false 表示该模型不支持思考，不返回任何档位 capability
    if (input.profile.reasoning === false) return undefined
    return {
      source: 'profile',
      levels: input.profile.levels,
      defaultLevel: input.profile.defaultLevel,
    }
  }

  if (!input.catalog) return undefined
  const levels = getPiCatalogThinkingLevels(input.catalog)
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  const defaultLevel = normalizeReasoningCapabilityLevel(
    { source: 'pi-catalog', levels, defaultLevel: 'high' },
    'high',
  ) ?? levels[0]!
  return {
    source: 'pi-catalog',
    levels,
    defaultLevel,
  }
}

/**
 * 与 Pi `clampThinkingLevel` 保持一致：请求档位不可用时优先向更高档位靠拢，再向低档位回退。
 */
export function normalizeReasoningCapabilityLevel(
  capability: ReasoningCapability | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  if (!capability) return level
  const requested = level ?? capability.defaultLevel
  if (capability.levels.includes(requested)) return requested

  // Some models (for example Fable 5.1) always reason and do not expose an off
  // mode. Preserve the product's "disabled" legacy setting as a safe, explicit
  // high-effort request instead of silently downgrading it to minimal.
  if (requested === 'off') {
    return capability.levels.includes('high') ? 'high' : capability.defaultLevel
  }

  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(requested)
  if (requestedIndex === -1) return capability.levels[0]
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  return capability.levels[0]
}

export function normalizeReasoningLevel(
  profile: ReasoningProfile | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  return profile ? profile.normalize(level) : level
}

// ============================================================================
// 用户自定义推理能力配置（打包后可修改）
//
// 通过 setReasoningProfileConfig 注入 ~/.proma/reasoning-profiles.json 中
// 的用户 profile；resolveReasoningProfile 会优先按 matchRules 命中这些配置，
// 未命中再回退内置硬编码 profile。
// ============================================================================

let _configuredProfiles: readonly { data: ReasoningProfileConfigData, profile: ReasoningProfile }[] = []

/** 全局可用的思考档位全集（供配置 UI 展示候选）。 */
export const ALL_THINKING_LEVELS: readonly AgentThinkingLevel[] = PI_EXTENDED_THINKING_LEVELS

/** 通用档位索引：用于把配置里的 defaultLevel/请求档位收敛到合法集合。 */
export const CONFIGURED_REASONING_LEVELS = PI_EXTENDED_THINKING_LEVELS

/**
 * 解析一个请求档位到给定 levels 集合的合法档位。
 *
 * 行为与内置 normalize 对齐：优先靠拢更高档位，再向低档位回退。
 */
export function normalizeConfiguredProfileLevel(
  levels: readonly AgentThinkingLevel[],
  level: AgentThinkingLevel | undefined,
  defaultLevel: AgentThinkingLevel,
): AgentThinkingLevel {
  const requested = level ?? defaultLevel
  if (levels.includes(requested)) return requested

  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(requested)
  if (requestedIndex === -1) return levels[0] ?? defaultLevel
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && levels.includes(candidate)) return candidate
  }
  return levels[0] ?? defaultLevel
}

function matchesRule(modelId: string, rule: ReasoningMatchRule): boolean {
  switch (rule.type) {
    case 'prefix':
      return modelId.startsWith(rule.value.toLowerCase())
    case 'exact':
      return modelId === rule.value.toLowerCase()
    case 'regex': {
      try {
        return new RegExp(rule.value, 'i').test(modelId)
      } catch {
        return false
      }
    }
  }
}

/** 判断一个配置 profile 是否命中给定模型。 */
export function doesMatchReasoningProfile(
  data: Pick<ReasoningProfileConfigData, 'matchRules'>,
  modelId: string,
): boolean {
  return data.matchRules.some((rule) => matchesRule(modelId, rule))
}

/**
 * 从持久化配置数据重建一个完整运行时 ReasoningProfile。
 *
 * normalize 用通用收敛逻辑重建（基于 levels + defaultLevel），
 * encodings 原样带入（effortMap 即用户配置的 thinkingLevelMap）。
 */
export function buildReasoningProfileFromConfig(
  data: ReasoningProfileConfigData,
): ReasoningProfile {
  const levels = data.levels.length > 0 ? data.levels : [data.defaultLevel ?? 'high']
  const defaultLevel = levels.includes(data.defaultLevel)
    ? data.defaultLevel
    : (levels[0] ?? data.defaultLevel ?? 'high')
  return {
    id: data.id,
    levels,
    defaultLevel,
    reasoning: data.reasoning,
    normalize: (level) => normalizeConfiguredProfileLevel(levels, level, defaultLevel),
    encodings: { ...data.encodings },
  }
}

/** 返回当前已注入的用户配置 profile 对应的数据（只读）。 */
export function getConfiguredReasoningProfiles(): readonly ReasoningProfileConfigData[] {
  return _configuredProfiles.map((entry) => entry.data)
}

/**
 * 注入用户自定义推理能力配置。
 *
 * 由主进程启动时（及配置变更后）调用；传入 null/空数组则清空，恢复纯内置。
 * 同一 id 的配置按匹配顺序保留，作为后续 resolve 的候选。
 */
export function setReasoningProfileConfig(
  profiles: readonly ReasoningProfileConfigData[] | null | undefined,
): void {
  if (!profiles || profiles.length === 0) {
    _configuredProfiles = []
    return
  }
  _configuredProfiles = profiles.map((data) => ({ data, profile: buildReasoningProfileFromConfig(data) }))
}

/** 按模型 id 与 transport 匹配注入配置中的 profile。 */
function resolveConfiguredProfileForModel(
  modelId: string,
  transport: ReasoningTransport,
): ReasoningProfile | undefined {
  // 多个 profile 均命中时，选“匹配规则更具体”的那个（value 最长），
  // 避免宽的通用规则（如 standard 的 gpt-5 前缀）抢先捕获更专属的
  // 子系列（如 gpt-5.6 应命中 openai-reasoning-max）。
  let bestProfile: ReasoningProfile | undefined
  let bestLength = -1
  for (const { data, profile } of _configuredProfiles) {
    // 仅当该 profile 声明了此 transport 的 encoding，才参与命中
    const encoding = data.encodings[transport]
    if (!encoding) continue
    // 该 profile 内所有命中规则里最长的 value 长度，作为“具体度”评分
    let profileLength = -1
    for (const rule of data.matchRules) {
      if (matchesRule(modelId, rule)) {
        profileLength = Math.max(profileLength, rule.value.length)
      }
    }
    // 并列时保留先出现者（维持配置顺序偏好），仅选取更具体的 profile
    if (profileLength >= 0 && profileLength > bestLength) {
      bestLength = profileLength
      bestProfile = profile
    }
  }
  return bestProfile
}

