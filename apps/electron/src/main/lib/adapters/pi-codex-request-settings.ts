import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getCodexSpeeds, isCodexSpeed, isCodexSpeedSupportedModel, resolveCodexSpeed, type CodexSpeed } from '@proma/shared'

type ProviderPayload = Record<string, unknown>

/** 与官方 0.21.88 的 CODEX_SERVICE_TIERS 对齐。 */
export const CODEX_SERVICE_TIERS: Record<CodexSpeed, string> = {
  standard: 'default',
  fast: 'priority',
  ultrafast: 'ultrafast',
}

/** 保留旧导出名，避免调用方一次性全改。 */
export const CODEX_FAST_MODE_SERVICE_TIER = CODEX_SERVICE_TIERS.fast

export interface CodexSpeedSettings {
  /** 目标速度；standard 时不注入 service_tier。 */
  speed?: CodexSpeed
  /** 兼容旧字段：true 等价于 fast。 */
  fastMode?: boolean
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

function resolveRequestSpeed(settings: CodexSpeedSettings | undefined, modelId: string | undefined): CodexSpeed {
  if (isCodexSpeed(settings?.speed)) return resolveCodexSpeed({ codexSpeed: settings.speed }, modelId)
  if (settings?.fastMode === true) return resolveCodexSpeed({ codexFastMode: true }, modelId)
  return 'standard'
}

/** 为符合条件的 Codex Responses 请求附加对应的 service tier。 */
export function injectCodexSpeed(payload: unknown, speed: CodexSpeed): unknown {
  if (speed === 'standard') return payload
  if (!isProviderPayload(payload)) return payload
  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  if (!isCodexSpeedSupportedModel(speed, modelId)) return payload
  return { ...payload, service_tier: CODEX_SERVICE_TIERS[speed] }
}

/** 兼容旧签名：等价于 speed='fast'。 */
export function injectCodexFastMode(payload: unknown): unknown {
  return injectCodexSpeed(payload, 'fast')
}

/** Pi Agent 内部 stream function 使用的 provider 专属 service tier。 */
export function withCodexServiceTier<T extends object | undefined>(options: T, speed: CodexSpeed): T & { serviceTier: string } {
  return { ...options, serviceTier: CODEX_SERVICE_TIERS[speed] } as T & { serviceTier: string }
}

/** 兼容旧签名。 */
export function withCodexFastModeServiceTier<T extends object | undefined>(options: T): T & { serviceTier: string } {
  return withCodexServiceTier(options, 'fast')
}

/** Pi inline extension：按会话/全局速度注入 service tier。 */
export function createCodexSpeedExtension(settings: CodexSpeedSettings): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const modelId = isProviderPayload(event.payload) && typeof event.payload.model === 'string' ? event.payload.model : undefined
      const speed = resolveRequestSpeed(settings, modelId)
      if (speed === 'standard') return undefined
      const updatedPayload = injectCodexSpeed(event.payload, speed)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}

/** 兼容旧导出名。 */
export function createCodexFastModeExtension(settings: { fastMode?: boolean }): (pi: ExtensionAPI) => void {
  return createCodexSpeedExtension(settings)
}

/** 某模型可选的速度档位；供 UI 决定是否显示下压菜单。 */
export function getModelCodexSpeeds(modelId: string | undefined): CodexSpeed[] {
  return getCodexSpeeds(modelId)
}
