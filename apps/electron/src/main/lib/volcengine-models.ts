/**
 * 火山引擎（豆包）模型目录解析。
 *
 * 官方 0.22.60：豆包模型接入能力表与推理档位，未登记型号回退 500K 上下文。
 * 方舟 `/models` 返回的字段比通用 OpenAI 目录更丰富，除 id 外还带
 * token_limits / modalities / features.thinking / effort，这里只做安全解析，
 * 不信任缺失或类型不符的字段。
 */

export interface VolcengineModelEffort {
  supportedLevels?: string[]
  defaultLevel?: string
}

export interface VolcengineModelInfo {
  id: string
  name: string
  status?: string
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  inputModalities?: string[]
  thinkingType?: string
  effort?: VolcengineModelEffort
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    const text = nonEmptyString(item)
    return text === undefined ? [] : [text]
  })
}

/** 解析方舟模型列表；无法识别的条目直接跳过，不影响其他模型。 */
export function parseVolcengineModels(payload: unknown): VolcengineModelInfo[] {
  const data = record(payload)?.data
  if (!Array.isArray(data)) return []

  return data.flatMap((item) => {
    const model = record(item)
    const id = nonEmptyString(model?.id)
    if (!model || !id) return []

    const limits = record(model.token_limits)
    const modalities = record(model.modalities)
    const features = record(model.features)
    const thinking = record(features?.thinking)
    const effort = record(model.effort)
    const supportedLevels = stringList(effort?.supported_levels)
    const defaultLevel = nonEmptyString(effort?.default_level)
    const parsedEffort: VolcengineModelEffort | undefined = supportedLevels !== undefined || defaultLevel !== undefined
      ? {
          ...(supportedLevels !== undefined && { supportedLevels }),
          ...(defaultLevel !== undefined && { defaultLevel }),
        }
      : undefined

    const status = nonEmptyString(model.status)
    const contextWindow = positiveInteger(model.context_window) ?? positiveInteger(limits?.context_window)
    const maxInputTokens = positiveInteger(limits?.max_input_token_length)
    const maxOutputTokens = positiveInteger(model.max_output_tokens) ?? positiveInteger(limits?.max_output_token_length)
    const inputModalities = stringList(modalities?.input_modalities)
    const thinkingType = nonEmptyString(thinking?.type)

    return [{
      id,
      name: nonEmptyString(model.name) ?? id,
      ...(status !== undefined && { status }),
      ...(contextWindow !== undefined && { contextWindow }),
      ...(maxInputTokens !== undefined && { maxInputTokens }),
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(inputModalities !== undefined && { inputModalities }),
      ...(thinkingType !== undefined && { thinkingType }),
      ...(parsedEffort !== undefined && { effort: parsedEffort }),
    }]
  })
}
