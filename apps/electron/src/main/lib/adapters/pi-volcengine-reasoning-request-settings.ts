/**
 * 火山引擎（豆包）推理档位请求改写。
 *
 * 官方 0.22.60：豆包模型接入推理档位。方舟兼容端点的思考协议并不统一：
 * - 部分型号用 `thinking: {type: disabled|enabled}`，部分完全不接受 thinking；
 * - 强度字段可能是 `reasoning_effort`，且只支持 low/high/max 等子集；
 * - 未登记型号必须保持请求原样，不能凭型号猜测字段。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AgentThinkingLevel } from '@proma/shared'

type ProviderPayload = Record<string, unknown>

interface VolcengineModelSpec {
  thinking: 'enabled-disabled' | 'enabled-only' | 'absent'
  efforts: readonly AgentThinkingLevel[]
  /** off 或 minimal 是否直接关闭 thinking（仅 enabled-disabled 有效）。 */
  minimalDisables?: boolean
  /** 本地档位到方舟档位的映射；未列出的档位按距离最近处理。 */
  aliases: Partial<Record<AgentThinkingLevel, AgentThinkingLevel>>
}

const SEED: VolcengineModelSpec = {
  thinking: 'enabled-disabled',
  efforts: ['low', 'medium', 'high'],
  minimalDisables: true,
  aliases: { xhigh: 'high', max: 'high' },
}
const DEEPSEEK_V41: VolcengineModelSpec = {
  thinking: 'enabled-disabled',
  efforts: ['low', 'high', 'max'],
  aliases: { minimal: 'low', medium: 'high', xhigh: 'high' },
}
const DEEPSEEK_GA: VolcengineModelSpec = {
  ...DEEPSEEK_V41,
  minimalDisables: true,
  aliases: { medium: 'low', xhigh: 'high' },
}
const GLM52: VolcengineModelSpec = {
  thinking: 'enabled-disabled',
  efforts: ['high', 'max'],
  minimalDisables: true,
  aliases: { low: 'high', medium: 'high', xhigh: 'max' },
}
const GLM53: VolcengineModelSpec = {
  thinking: 'enabled-only',
  efforts: ['low', 'high', 'max'],
  aliases: { minimal: 'low', medium: 'high', xhigh: 'max' },
}
const KIMI: VolcengineModelSpec = {
  thinking: 'absent',
  efforts: ['low', 'high', 'max'],
  aliases: { medium: 'low', xhigh: 'max' },
}

/** 已实测的方舟模型清单；不在表内的型号不改写请求。 */
const MODEL_SPECS: Readonly<Record<string, VolcengineModelSpec>> = {
  'doubao-seed-evolving': SEED,
  'doubao-seed-2-1-pro-260915': SEED,
  'doubao-seed-2-1-lite-260915': SEED,
  'doubao-seed-2-1-pro-260628': SEED,
  'doubao-seed-2-1-turbo-260628': SEED,
  'deepseek-v4-1-flash-261017': DEEPSEEK_V41,
  'deepseek-v4-1-flash-260910': DEEPSEEK_V41,
  'deepseek-v4-1-flash-economy-261017': DEEPSEEK_V41,
  'deepseek-v4-pro-ga-260813': DEEPSEEK_GA,
  'deepseek-v4-flash-ga-260731': DEEPSEEK_GA,
  'glm-5-2-260617': GLM52,
  'glm-5-3-flash-260828': GLM53,
  'kimi-k3-1-pro-261024': KIMI,
}

const ORDER: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface VolcengineReasoningSettings {
  thinkingLevel?: AgentThinkingLevel
  /** 目录声明的可用档位；缺省时使用本地实测表。 */
  supportedLevels?: readonly string[]
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

/** 解析模型可用的本地档位；未登记型号返回 undefined 表示不改写。 */
export function resolveVolcengineReasoningCapability(
  modelId: string | undefined,
  supportedLevels?: readonly string[],
): { levels: readonly AgentThinkingLevel[]; thinking: VolcengineModelSpec['thinking'] } | undefined {
  const spec = modelId && Object.hasOwn(MODEL_SPECS, modelId) ? MODEL_SPECS[modelId] : undefined
  if (!spec) return undefined
  const efforts = supportedLevels?.length
    ? spec.efforts.filter((level) => supportedLevels.includes(level))
    : [...spec.efforts]
  const levels: AgentThinkingLevel[] = spec.thinking === 'enabled-disabled' ? ['off', ...efforts] : [...efforts]
  return { levels, thinking: spec.thinking }
}

/** 把本地思考档位改写为方舟模型接受的 thinking / reasoning_effort。 */
export function injectVolcengineReasoningLevel(
  payload: unknown,
  settings: VolcengineReasoningSettings,
): unknown {
  if (!isProviderPayload(payload)) return payload
  const original = payload
  if (typeof original.model !== 'string' || !Array.isArray(original.messages) || !settings.thinkingLevel) return payload

  const capability = resolveVolcengineReasoningCapability(original.model, settings.supportedLevels)
  const spec = MODEL_SPECS[original.model]
  if (!capability || !spec) return payload

  const level = settings.thinkingLevel
  if (!ORDER.includes(level)) return payload

  if ((level === 'off' || (level === 'minimal' && spec.minimalDisables)) && capability.thinking === 'enabled-disabled') {
    const { reasoning_effort: _effort, ...body } = original
    return { ...body, thinking: { type: 'disabled' } }
  }

  const candidates = capability.levels.filter((item) => item !== 'off' && item !== 'minimal' && item !== 'xhigh')
  if (candidates.length === 0) {
    if (capability.thinking === 'enabled-disabled') return payload
    const { thinking: _thinking, reasoning_effort: _effort, ...body } = original
    return capability.thinking === 'absent' ? body : { ...body, thinking: { type: 'enabled' } }
  }

  const target = ORDER.indexOf(spec.aliases[level] ?? level)
  const effort = candidates.reduce((best, candidate) =>
    Math.abs(ORDER.indexOf(candidate) - target) < Math.abs(ORDER.indexOf(best) - target) ? candidate : best)
  const { thinking: _thinking, ...body } = original
  return capability.thinking === 'absent'
    ? { ...body, reasoning_effort: effort }
    : { ...body, thinking: { type: 'enabled' }, reasoning_effort: effort }
}

/** Pi inline extension for Volcengine reasoning settings. */
export function createVolcengineReasoningRequestExtension(
  settings: VolcengineReasoningSettings,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const body = injectVolcengineReasoningLevel(event.payload, settings)
      return body === event.payload ? undefined : body
    })
  }
}
