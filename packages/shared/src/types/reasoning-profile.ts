import { isGpt6AstraFamily, isGpt6LunaFamily, isGpt6SolFamily } from '../utils/model-family'
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
    case 'zhipu':
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
  /** 本轮完整配置快照；显式传入（包括 []）时不读取全局配置或硬编码回退。 */
  profiles?: readonly ReasoningProfileConfigData[]
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
  /** v1 为用户覆盖列表；v2 起为完整列表，空列表表示删除全部。 */
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

const DEEPSEEK_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-flash',
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

/**
 * Kimi K3.1 与官方 0.21.88 对齐：只有 low / high / max 三档，没有 off。
 * `off` 按官方 normalize 映射为 low（思考强制开启），API 与 Coding Plan 默认档不同。
 */
const K3_31_EFFORT_MAP: ReasoningEffortMap = {
  ...K3_EFFORT_MAP,
  off: 'low',
}

function createKimiK31Profile(coding: boolean): ReasoningProfile {
  const defaultLevel: AgentThinkingLevel = coding ? 'high' : 'max'
  return {
    id: coding ? 'kimi-k3.1-coding' : 'kimi-k3.1-api',
    levels: ['low', 'high', 'max'],
    defaultLevel,
    normalize: (level) => level === undefined ? defaultLevel : level === 'off' ? 'low' : normalizeK3Level(level),
    encodings: {
      'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_31_EFFORT_MAP },
      'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_31_EFFORT_MAP },
    },
  }
}

const KIMI_K31_API_PROFILE = createKimiK31Profile(false)
const KIMI_K31_CODING_PROFILE = createKimiK31Profile(true)

/** K3.1 的模型 ID 判定：兼容本地 profile 别名与官方 K3.1 Pro 模型 ID。 */
function isKimiK31Model(modelId: string): boolean {
  return modelId.startsWith('kimi-k3.1')
    || /^(?:kimi-)?k3\.1-pro(?:-highspeed)?$/.test(modelId)
}

/** Coding Plan 的 K3.1：本地 `kimi-k3.1-coding` 或官方无前缀 `k3.1-pro*`。 */
function isKimiK31CodingModel(modelId: string): boolean {
  return modelId.startsWith('kimi-k3.1-coding') || /^k3\.1-pro(?:-highspeed)?$/.test(modelId)
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

/** 官方 0.21.67-01：GPT-6.1 Terra 沿用 Astra 的档位集合，仅 profile id 不同。 */
const OPENAI_TERRA_PROFILE: ReasoningProfile = {
  ...OPENAI_ASTRA_PROFILE,
  id: 'openai-reasoning-terra',
}

/** GPT-6 Sol/Luna allow disabling reasoning and default to medium effort. */
const OPENAI_SOL_LUNA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-sol-luna',
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'medium',
  normalize: (level) => level === 'minimal' ? 'low' : level ?? 'medium',
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  KIMI_K31_API_PROFILE,
  KIMI_K31_CODING_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_ASTRA_PROFILE,
  OPENAI_TERRA_PROFILE,
  OPENAI_SOL_LUNA_PROFILE,
]

/** 内置 profile 的缺省匹配规则（与 resolveReasoningProfile 的内置匹配逻辑一致）。 */
const BUILTIN_PROFILE_MATCH_RULES: Record<string, ReasoningMatchRule[]> = {
  'deepseek-flash': [{ type: 'regex', value: '^deepseek-flash(?:-|$)' }],
  'deepseek-v4-flash': [{ type: 'regex', value: '^deepseek-v4-flash(?:-|$)' }],
  'deepseek-v4-pro': [{ type: 'regex', value: '^deepseek-v4-pro(?:-|$)' }],
  'kimi-k3': [{ type: 'regex', value: '^(?:k3(?:-256k)?|kimi-k3)$' }],
  'kimi-k3.1-api': [
    { type: 'exact', value: 'kimi-k3.1-api' },
    { type: 'regex', value: '^kimi-k3\\.1-pro(?:-highspeed)?$' },
  ],
  'kimi-k3.1-coding': [
    { type: 'exact', value: 'kimi-k3.1-coding' },
    { type: 'regex', value: '^k3\\.1-pro(?:-highspeed)?$' },
  ],
  'glm-5.3': [{ type: 'regex', value: '^glm-5\\.3(?:-flashx?)?$' }],
  'glm-5.2': [{ type: 'exact', value: 'glm-5.2' }],
  'openai-reasoning-standard': [{ type: 'regex', value: '^gpt-5(?!.*-chat-latest$)(?!\\.6(?:-|$))' }, { type: 'regex', value: '^(?:o1|o3|o4)(?:-|$)' }],
  'openai-reasoning-max': [{ type: 'regex', value: '^gpt-5\\.6(?!.*-chat-latest$)(?:-|$)' }],
  'openai-reasoning-astra': [{ type: 'regex', value: '^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$' }],
  'openai-reasoning-terra': [{ type: 'exact', value: 'gpt-6.1-terra' }, { type: 'exact', value: 'gpt-6.1-terra-1' }],
  'openai-reasoning-sol-luna': [{ type: 'regex', value: '^gpt-6-(?:sol|luna)$' }],
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
 * 默认兼容覆盖模式：未命中时回退硬编码。传入 profiles 快照或使用 authoritative
 * 全局配置时，将完整列表作为唯一 profile 来源，不会补回已删除条目。
 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  const modelId = input.modelId?.toLowerCase()
  if (!modelId) return undefined
  if (input.profiles !== undefined) {
    return resolveConfiguredProfileForModel(modelId, input.transport, input.profiles)
  }

  // 完整配置是权威列表，删除的内置规则不得通过硬编码重新启用。
  const configuredProfile = resolveConfiguredProfileForModel(modelId, input.transport, _configuredProfiles, _authoritativeProfiles)
  if (configuredProfile || _authoritativeProfiles) return configuredProfile

  // 2) 内置硬编码 profile（以下保持原逻辑）
  const isOpenAITransport = input.transport === 'openai-completions' || input.transport === 'openai-responses'
  const isOpenAIReasoningModel = !modelId.endsWith('-chat-latest')
    && (modelId.startsWith('gpt-5') || /^(o1|o3|o4)(?:-|$)/.test(modelId))
  if (modelId === 'gpt-6.1-terra' || modelId === 'gpt-6.1-terra-1') {
    return OPENAI_TERRA_PROFILE.encodings[input.transport] ? OPENAI_TERRA_PROFILE : undefined
  }
  if (isGpt6AstraFamily(modelId)) {
    return OPENAI_ASTRA_PROFILE.encodings[input.transport] ? OPENAI_ASTRA_PROFILE : undefined
  }
  if (isGpt6SolFamily(modelId) || isGpt6LunaFamily(modelId)) {
    return OPENAI_SOL_LUNA_PROFILE.encodings[input.transport] ? OPENAI_SOL_LUNA_PROFILE : undefined
  }
  // K3.1 与 K3 是不同档位集合，必须先判定，避免被 kimi-k3 前缀规则吞掉。
  if (isKimiK31Model(modelId)) {
    const k31 = isKimiK31CodingModel(modelId) ? KIMI_K31_CODING_PROFILE : KIMI_K31_API_PROFILE
    return k31.encodings[input.transport] ? k31 : undefined
  }
  const profile = /^deepseek-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_FLASH_PROFILE
    : /^deepseek-v4-flash(?:-|$)/.test(modelId)
      ? DEEPSEEK_V4_FLASH_PROFILE
      : /^deepseek-v4-pro(?:-|$)/.test(modelId)
        ? DEEPSEEK_V4_PRO_PROFILE
      : /^(?:k3(?:-256k)?|kimi-k3)$/.test(modelId)
        ? K3_PROFILE
        : modelId === 'glm-5.3' || modelId === 'glm-5.3-flash' || modelId === 'glm-5.3-flashx'
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
  if (requested === 'off' && capability.source === 'pi-catalog') {
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
  if (profile?.reasoning === false) return 'off'
  return profile ? profile.normalize(level) : level
}

// ============================================================================
// 用户自定义推理能力配置（打包后可修改）
//
// 通过 setReasoningProfileConfig 注入 ~/.proma/reasoning-profiles.json 中
// 的用户 profile；resolveReasoningProfile 会优先按 matchRules 命中这些配置，
// 未命中再回退内置硬编码 profile。
// ============================================================================

let _configuredProfiles: readonly ReasoningProfileConfigData[] = []
let _authoritativeProfiles = false

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
  transport?: ReasoningTransport,
): ReasoningProfile {
  const configuredLevels = data.levels.length > 0 ? data.levels : [data.defaultLevel ?? 'high']
  const effortMap = transport ? data.encodings[transport]?.effortMap : undefined
  const availableLevels = configuredLevels.filter((level) => effortMap?.[level] !== null)
  const levels: readonly AgentThinkingLevel[] = availableLevels.length > 0 ? availableLevels : ['off']
  const defaultLevel = levels.includes(data.defaultLevel)
    ? data.defaultLevel
    : (levels[0] ?? data.defaultLevel ?? 'high')
  return {
    id: data.id,
    levels,
    defaultLevel,
    reasoning: data.reasoning && availableLevels.length > 0,
    normalize: (level) => normalizeConfiguredProfileLevel(levels, level, defaultLevel),
    encodings: { ...data.encodings },
  }
}

/** 返回当前已注入的用户配置 profile 对应的数据（只读）。 */
export function getConfiguredReasoningProfiles(): readonly ReasoningProfileConfigData[] {
  return _configuredProfiles
}

/**
 * 注入用户自定义推理能力配置。
 *
 * authoritative 模式接受完整列表，[] 表示没有任何 profile；null 恢复未注入状态。
 * 缺省兼容旧版的部分覆盖模式。
 */
export function setReasoningProfileConfig(
  profiles: readonly ReasoningProfileConfigData[] | null | undefined,
  options?: { authoritative?: boolean },
): void {
  _configuredProfiles = profiles ? structuredClone(profiles) : []
  _authoritativeProfiles = profiles != null && options?.authoritative === true
}

/** 按模型 id 与 transport 匹配注入配置中的 profile。 */
function resolveConfiguredProfileForModel(
  modelId: string,
  transport: ReasoningTransport,
  profiles: readonly ReasoningProfileConfigData[],
  authoritative = true,
): ReasoningProfile | undefined {
  // 精确匹配优先于前缀，前缀优先于正则；不能把正则语法长度当成具体度。
  // 同类型前缀选择最长项，正则并列时保持配置顺序。
  let bestProfile: ReasoningProfile | undefined
  let bestRank = -1
  let bestLength = -1
  for (const data of profiles) {
    // 仅当该 profile 声明了此 transport 的 encoding，才参与命中
    const encoding = data.encodings[transport]
    if (!encoding) continue
    for (const rule of data.matchRules) {
      if (!matchesRule(modelId, rule)) continue
      const rank = rule.type === 'exact' ? 3 : rule.type === 'prefix' ? 2 : 1
      const length = rule.type === 'regex' ? 0 : rule.value.length
      if (rank > bestRank || (rank === bestRank && length > bestLength)) {
        bestRank = rank
        bestLength = length
        bestProfile = buildReasoningProfileFromConfig(data, authoritative ? transport : undefined)
      }
    }
  }
  return bestProfile
}

