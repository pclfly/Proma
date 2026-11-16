/**
 * GPT-6 model-family recognition shared by channel, runtime, and UI code.
 *
 * Astra can carry hyphenated SKU suffixes returned by Codex. Sol and Luna are
 * exact IDs so nearby names are never routed as an official model by mistake.
 */
const GPT_6_ASTRA_FAMILY_PATTERN = /^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const GPT_6_SOL_MODEL_ID = 'gpt-6-sol'
const GPT_6_LUNA_MODEL_ID = 'gpt-6-luna'
const GPT_61_SOL_MODEL_ID = 'gpt-6.1-sol'
/** 官方 0.21.68-02：Terra 的 -1 变体是同一模型的不同入口，思考档位与 fast mode 判据都按同族处理。 */
const GPT_61_TERRA_MODEL_IDS = new Set(['gpt-6.1-terra', 'gpt-6.1-terra-1'])

function normalizeModelId(modelId: string | undefined): string | undefined {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
}

export function isGpt6AstraFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_ASTRA_FAMILY_PATTERN.test(normalized)
}

export function isGpt6SolFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_SOL_MODEL_ID
}

export function isGpt6LunaFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_LUNA_MODEL_ID
}

/** GPT-6.1 Sol 是独立 SKU，支持 ultrafast 档；不能与 gpt-6-sol 混判。 */
export function isGpt61SolFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_61_SOL_MODEL_ID
}

/** GPT-6.1 Terra 家族（含 -1 变体）。 */
export function isGpt61TerraFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_61_TERRA_MODEL_IDS.has(normalized)
}
