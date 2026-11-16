import type { AgentThinkingLevel } from '../types/agent'

export type GeminiThinkingLevel = Extract<AgentThinkingLevel, 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>

export interface GeminiModelCapability {
  contextWindow: number
  maxOutputTokens: number
  thinkingLevels: readonly GeminiThinkingLevel[]
  defaultThinkingLevel: GeminiThinkingLevel
}

const ONE_MILLION = 1_000_000
// Gemini 4 家族按官方目录使用 1,048,576，而不是十进制 1e6。
const GEMINI_4_CONTEXT_WINDOW = 1_048_576
const SIXTY_FOUR_K = 65_536

const ALL_LEVELS = ['minimal', 'low', 'medium', 'high'] as const satisfies readonly GeminiThinkingLevel[]
const NO_MINIMAL_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly GeminiThinkingLevel[]

/**
 * Gemini 文本模型的产品级能力表。
 *
 * Pi catalog 负责 Agent runtime 的协议与计费元数据；这里仅保存 Proma 必须跨
 * Agent、Chat 和上下文展示共用的官方模型约束，避免把 Image / Live SKU 误判为 1M。
 */
const GEMINI_TEXT_MODEL_CAPABILITIES: Readonly<Record<string, GeminiModelCapability>> = {
  'gemini-3-flash-preview': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'high',
  },
  'gemini-3.1-pro': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'high',
  },
  'gemini-3.1-pro-preview': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'high',
  },
  // Google catalog 在启用 custom tools 时使用此精确别名；它仍是同一文本模型，
  // 不能误回退到旧版 thinkingBudget 或默认 200K 上下文。
  'gemini-3.1-pro-preview-customtools': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'high',
  },
  'gemini-3.1-flash-lite': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'minimal',
  },
  'gemini-3.1-flash-lite-preview': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'minimal',
  },
  'gemini-3.5-flash': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
  'gemini-3.5-flash-lite': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'minimal',
  },
  'gemini-3.6-flash': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ALL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
  'gemini-3.7-flash': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
  'gemini-3.8-flash': {
    contextWindow: ONE_MILLION,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
  // Gemini 4 Argon 只接受 low / medium / high 三档离散 thinkingLevel，
  // 官方 0.21.92：此前选中档位会直接 400，旧会话中的不兼容档位按中档归一。
  // Hydrogen 是 Gemini 4 中唯一开放 xhigh 的型号；输入、思考与输出共享 1,048,576。
  'gemini-4-hydrogen': {
    contextWindow: GEMINI_4_CONTEXT_WINDOW,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
    defaultThinkingLevel: 'high',
  },
  // Argon 与 Carbon 只接受 low/medium/high，传 minimal 或旧 thinkingBudget 会 400。
  'gemini-4-carbon': {
    contextWindow: GEMINI_4_CONTEXT_WINDOW,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
  'gemini-4-argon': {
    contextWindow: GEMINI_4_CONTEXT_WINDOW,
    maxOutputTokens: SIXTY_FOUR_K,
    thinkingLevels: NO_MINIMAL_LEVELS,
    defaultThinkingLevel: 'medium',
  },
}

function normalizeGeminiModelId(modelId: string | undefined): string | undefined {
  // 目录外的自定义渠道可能带 vendor 前缀（google/gemini-4-argon），
  // 与 reasoning profile 一致按最后一段匹配。
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/^models\//, '').split('/').pop()
}

export function getGeminiModelCapability(modelId: string | undefined): GeminiModelCapability | undefined {
  const normalized = normalizeGeminiModelId(modelId)
  return normalized ? GEMINI_TEXT_MODEL_CAPABILITIES[normalized] : undefined
}

export function normalizeGeminiThinkingLevel(
  modelId: string | undefined,
  // 入参放宽到 AgentThinkingLevel：旧会话可能留着 xhigh/max/off 等
  // 该模型从未支持的档位，必须在发送前归一到合法档位而不是原样下发。
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  const capability = getGeminiModelCapability(modelId)
  // 不在能力表里的模型不受这三档合约约束，原样透传由 Pi catalog 自行 clamp。
  if (!capability) return level
  if (!level) return capability.defaultThinkingLevel
  if (capability.thinkingLevels.includes(level as GeminiThinkingLevel)) return level as GeminiThinkingLevel
  // off / minimal 属于「尽量少想」，归到该模型支持的最低档（官方 profile 同为 off→low）；
  // 其余越界档位（如只支持三档的模型收到 max）退回到默认档。
  if (level === 'off' || level === 'minimal') return capability.thinkingLevels[0]
  return capability.defaultThinkingLevel
}
