/**
 * 破甲 · Seep provider 放行扩展（Proma 版）
 *
 * 来源：Seep 工作台 `Tool/prompts/extensions/security-audit-interceptor.ts` 的
 * `before_provider_request` 钩子。只移植其中真正起作用的一件事：对 Google/Gemini
 * 端点把 `safetySettings` 置为 `BLOCK_NONE`。
 *
 * **刻意不移植**原扩展的另外两个钩子：
 * - `input`：会改写用户原始输入（口语 → 合规术语包裹）。Proma 的输入是用户可见的
 *   原文，改写它会让会话记录、标题、搜索与用户预期不一致。
 * - `context`：会清洗历史消息正文。Proma 需要保真的历史以支持回溯与归档。
 * 这两个钩子属于 Seep 工作台的合规链路，不是 Proma 的运行前提。
 *
 * 端点判定沿用原实现的顺序：先看请求体形状（`messages` = OpenAI 兼容，
 * `contents` = Gemini 原生），再用 model 的 api/provider 标识兜底。
 * 对 OpenAI 兼容网关注入 `safetySettings` 会导致 400 UNKNOWN_FIELD，必须避开。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Google 端点注入的放行配置（与 Seep 原实现一致）。 */
const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
] as const

const GOOGLE_API_IDS = new Set(['google-generative-ai', 'google-vertex'])
const GOOGLE_PROVIDER_RE = /^(google|gemini|vertex|google-vertex|google-ai-studio)/i

interface ModelLike {
  api?: unknown
  provider?: unknown
}

/**
 * 判断是否应该向这次请求注入 safetySettings。
 *
 * 结构指纹优先于名称：中转链路常把 Gemini 模型挂在 OpenAI 兼容体后面，
 * 此时按名字判断会注入错误字段。反之亦然。
 */
export function shouldInjectSafetySettings(
  payload: unknown,
  model: ModelLike | undefined,
): boolean {
  if (!payload || typeof payload !== 'object') return false
  const body = payload as { messages?: unknown; contents?: unknown }

  // OpenAI 兼容体带 messages；Gemini 原生体带 contents。
  if (Array.isArray(body.messages)) return false
  if (Array.isArray(body.contents)) return true

  const api = typeof model?.api === 'string' ? model.api : ''
  if (api && GOOGLE_API_IDS.has(api)) return true
  const provider = typeof model?.provider === 'string' ? model.provider : ''
  return Boolean(provider) && GOOGLE_PROVIDER_RE.test(provider)
}

/**
 * 创建破甲 provider 放行扩展。
 *
 * 只注册 `before_provider_request`；不做输入改写、不动历史消息。
 * 调用方必须在破甲关闭时不注册本扩展——它没有自己的开关状态，
 * 是否生效完全由破甲开关决定。
 */
export function createSeepProviderSafetyExtension(): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on('before_provider_request', (event, ctx) => {
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== 'object') return

      if (!shouldInjectSafetySettings(payload, ctx.model as ModelLike | undefined)) return

      // 多层注入：不同版本的 Google SDK 读取位置不一致，原实现同样三处都写。
      payload.safetySettings = GEMINI_SAFETY_SETTINGS
      if (!payload.config || typeof payload.config !== 'object') payload.config = {}
      ;(payload.config as Record<string, unknown>).safetySettings = GEMINI_SAFETY_SETTINGS
      if (payload.generationConfig && typeof payload.generationConfig === 'object') {
        ;(payload.generationConfig as Record<string, unknown>).safetySettings = GEMINI_SAFETY_SETTINGS
      }
    })
  }
}
