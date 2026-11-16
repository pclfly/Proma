/**
 * OpenAI Responses 文本阶段（commentary / final_answer）解析。
 *
 * 独立成模块，避免 pi-message-adapter 与 pi-assistant-block 互相导入。
 */

export type PiAssistantTextPhase = 'commentary' | 'final_answer'

/** 从 OpenAI Responses 的 textSignature 提取 commentary/final_answer 阶段。 */
export function getPiAssistantTextPhase(
  api: string | undefined,
  textSignature: string | undefined,
): PiAssistantTextPhase | undefined {
  if (
    api !== 'openai-responses'
    && api !== 'openai-codex-responses'
    && api !== 'azure-openai-responses'
  ) return undefined
  if (typeof textSignature !== 'string' || !textSignature.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(textSignature)
    if (!parsed || typeof parsed !== 'object') return undefined
    const signature = parsed as Record<string, unknown>
    if (signature.v !== 1 || typeof signature.id !== 'string') return undefined
    return signature.phase === 'commentary' || signature.phase === 'final_answer'
      ? signature.phase
      : undefined
  } catch {
    return undefined
  }
}
