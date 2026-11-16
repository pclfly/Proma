/** 协作正文预算使用 UTF-16 字符数，不冒充精确 token 计数；原会话内容始终保留。 */
export interface DelegationResultBudgetOptions {
  totalChars?: number
  perResultChars?: number
  offset?: number
}
interface ResultRead {
  totalChars: number
  offset: number
  returnedChars: number
  truncated: boolean
  nextOffset: number | null
}
type Budgeted<T> = T extends Array<infer U> ? Array<Budgeted<U>> : T extends object
  ? { [K in keyof T]: Budgeted<T[K]> } & (T extends { resultSummary: string } ? { resultRead: ResultRead } : {}) : T
interface BudgetSummary {
  unit: 'utf16_chars'
  totalChars: number
  perResultChars: number
  returnedChars: number
  truncatedResults: number
  note?: string
  blockedPreviewChars: number
  blockedPreviewTruncated: boolean
  blockedPreviewNote?: string
}
interface TextSlot { object: Record<string, unknown>; text: string; offset: number; allowance: number }

function clamp(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), max)) : fallback
}
function safeBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

export function budgetDelegationResults<T extends object>(payload: T, options: DelegationResultBudgetOptions = {}): Budgeted<T> & { resultBudget: BudgetSummary } {
  const totalChars = clamp(options.totalChars, 12000, 64000)
  const perResultChars = clamp(options.perResultChars, 4000, 32000)
  const offset = clamp(options.offset, 0, Number.MAX_SAFE_INTEGER)
  const slots: TextSlot[] = []
  let blockedCharsRemaining = 8000
  let blockedTruncated = false
  const copyBlocked = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((child) => copyBlocked(child))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, copyBlocked(child, childKey)]))
    if (typeof value !== 'string' || /^(?:id|delegationId|childSessionId|requestId|blockedEventId|askUserRequestId|permissionRequestId|permissionToolName|type|toolName|status)$/.test(key)) return value
    const end = safeBoundary(value, Math.min(value.length, 1500, blockedCharsRemaining))
    blockedCharsRemaining -= end
    if (end < value.length) blockedTruncated = true
    return value.slice(0, end)
  }
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy)
    if (!value || typeof value !== 'object') return value
    const object = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'pendingBlockedEvents' ? copyBlocked(child) : copy(child)]))
    if (typeof object.resultSummary === 'string') {
      const text = object.resultSummary
      slots.push({ object, text, offset: safeBoundary(text, Math.min(offset, text.length)), allowance: 0 })
    }
    // 错误是状态的一部分，独立保留可读上限，不能挤占所有结果正文预算。
    if (typeof object.error === 'string' && object.error.length > 2000) {
      object.error = `${object.error.slice(0, 2000)}\n[错误详情已裁剪，请打开子会话查看]`
    }
    return object
  }
  const result = copy(payload) as Budgeted<T> & { resultBudget: BudgetSummary }
  let remaining = totalChars
  let pending = slots.filter((slot) => slot.text.length > slot.offset && perResultChars > 0)
  while (remaining > 0 && pending.length > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length))
    for (const slot of pending) {
      const amount = Math.min(share, remaining, perResultChars - slot.allowance, slot.text.length - slot.offset - slot.allowance)
      slot.allowance += amount
      remaining -= amount
    }
    pending = pending.filter((slot) => slot.allowance < perResultChars && slot.offset + slot.allowance < slot.text.length)
  }
  let returnedChars = 0, truncatedResults = 0
  for (const slot of slots) {
    const end = safeBoundary(slot.text, slot.offset + slot.allowance)
    const text = slot.text.slice(slot.offset, Math.max(end, slot.offset))
    const truncated = slot.offset + text.length < slot.text.length
    slot.object.resultSummary = text
    slot.object.resultRead = {
      totalChars: slot.text.length, offset: slot.offset, returnedChars: text.length,
      truncated, nextOffset: truncated ? slot.offset + text.length : null,
    } satisfies ResultRead
    returnedChars += text.length
    if (truncated) truncatedResults++
  }
  result.resultBudget = {
    unit: 'utf16_chars', totalChars, perResultChars, returnedChars, truncatedResults,
    blockedPreviewChars: 8000 - blockedCharsRemaining,
    blockedPreviewTruncated: blockedTruncated,
    ...(blockedTruncated ? { blockedPreviewNote: '阻塞问题为有界预览，选项文本可能已裁剪；请打开子会话核对完整问题后回答，不依据截断文本代答。原始事件未修改。' } : {}),
    ...(truncatedResults ? { note: '正文已按预算裁剪，原文未修改。需要精读时用 get_delegation_results 指定单个 delegationId，并传 resultOffset=resultRead.nextOffset 与预算继续读取。' } : {}),
  }
  return result
}
