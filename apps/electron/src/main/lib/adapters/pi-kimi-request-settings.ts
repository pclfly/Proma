import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  isKimiK31Model,
  normalizeReasoningLevel,
  resolveReasoningProfile,
  type AgentThinkingLevel,
  type ReasoningProfile,
} from '@proma/shared'

type ProviderPayload = Record<string, unknown>

export interface KimiRequestSettings {
  provider: 'kimi-api' | 'kimi-coding'
  profile?: ReasoningProfile
  thinkingLevel?: AgentThinkingLevel
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

/**
 * 将 Pi 通用 thinking 字段改写为 Kimi K3.1 的协议形态。
 *
 * - kimi-api 走 Anthropic Messages，强度写入 `output_config.effort`；
 * - kimi-coding 走 OpenAI Completions，强度写入 `reasoning_effort`；
 * - 两种协议都不接受 temperature/top_p/top_k/n 等采样字段，必须删除。
 */
export function injectKimiRequestSettings(
  payload: unknown,
  settings: KimiRequestSettings,
): unknown {
  if (!isProviderPayload(payload)) return payload
  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  if (!isKimiK31Model(modelId)) return payload

  const transport = settings.provider === 'kimi-coding' ? 'openai-completions' : 'anthropic-messages'
  const profile = settings.profile ?? resolveReasoningProfile({
    modelId,
    transport,
  })
  if (!profile) return payload
  const effort = normalizeReasoningLevel(profile, settings.thinkingLevel)
  if (!effort) return payload

  const body: ProviderPayload = { ...payload }
  for (const field of ['temperature', 'top_p', 'top_k', 'n', 'presence_penalty', 'frequency_penalty', 'thinking']) {
    delete body[field]
  }

  if (transport === 'openai-completions') {
    body.reasoning_effort = effort
    delete body.output_config
  } else {
    const existing = body.output_config
    body.output_config = {
      ...(isProviderPayload(existing) ? existing : {}),
      effort,
    }
    delete body.reasoning_effort
  }
  return body
}

/** Pi inline extension for Kimi K3.1 request settings. */
export function createKimiRequestExtension(
  settings: KimiRequestSettings,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = injectKimiRequestSettings(event.payload, settings)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}
