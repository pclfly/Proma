/**
 * Agent 请求图片预算：控制「一次请求里发多少张图、总共多大」，不做图片压缩。
 *
 * 职责划分（2026-11-04 起，与官方 0.21.88 语义配合）：
 * - **压缩**：由 Pi SDK 负责。`model-image-compression.ts` 把官方上限
 *   （1568 / 1e6 base64 / quality 85）并入 `model.inputLimits.images.resize`，
 *   Pi 在图片首次进入会话时压一次。这里不再重复解码、缩放或转码。
 * - **预算**：由本模块负责。官方没有这层能力，而多图请求仍可能因数量或总字节
 *   超出模型/渠道限制，因此按业务轮次边界裁剪，并给出明确的"未发送"提示。
 *
 * 本模块只改请求副本：不写附件、不改会话记录、不碰原始 base64。
 */

import type { ImageContent } from '@earendil-works/pi-ai'
import { findLatestExplicitUserIndex } from './agent-context-boundary'

export interface ImageRequestBudgetLimits {
  /** 一次请求最多发送多少张图。 */
  maxRequestImages: number
  /** 一次请求最多发送多少图片字节（base64 解码后的字节数）。 */
  maxRequestBytes: number
  /** 最多检查多少个候选；超出直接判为预算不足，避免为淘汰而扫描长历史。 */
  maxPreparedImages: number
  /** 预算计算的墙钟上限，防止超长历史拖慢请求。 */
  maxPreparationMs: number
}

export interface ImageProjectionStats {
  /** 本轮消息里出现的图片块总数。 */
  inputImages: number
  /** 实际参与预算判定的候选数。 */
  preparedImages: number
  /** 最终发送的图片数。 */
  sentImages: number
  /** 最终发送图片的字节数之和。 */
  sentBytes: number
  /** 因属于更早轮次而省略的数量。 */
  omittedHistorical: number
  /** 因数量/字节/时间预算不足而省略的数量。 */
  omittedBudget: number
}

interface ImageCandidate {
  messageIndex: number
  blockIndex: number
  block: ImageContent
  key: string
}

const HISTORICAL_IMAGE_NOTE =
  '[历史图片未随本次请求发送；原始会话和附件仍保留。如需要视觉信息，请依据对应工具参数或结果中的文件路径按需重新读取，不要推断未读取的图片内容。]'
const BUDGET_IMAGE_NOTE =
  '[图片未发送：本次请求的图片数量或总字节预算已满。原图仍保留；需要时请分批读取或生成联系表，不要假称已经看过。]'

const DEFAULT_LIMITS: ImageRequestBudgetLimits = {
  maxRequestImages: 6,
  maxRequestBytes: 8 * 1024 * 1024,
  maxPreparedImages: 12,
  maxPreparationMs: 10_000,
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('图片预算计算已取消', 'AbortError')
}

/** base64 字符数换算成解码后的字节数；不实际解码。 */
function decodedBytes(base64Length: number): number {
  return Math.floor(base64Length * 3 / 4)
}

/**
 * 估算一个图片块的原始字节数。
 *
 * 用 base64 长度反推，不 Buffer.from 解码，也不调用 sharp。
 * 单图是否超限由 Pi 的 resize 负责，这里只需要总量。
 */
function estimateBlockBytes(block: ImageContent): number | undefined {
  if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') return undefined
  if (!block.mimeType.startsWith('image/')) return undefined
  return decodedBytes(block.data.length)
}

export function createAgentImageRequestBudget(overrides: Partial<ImageRequestBudgetLimits> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  let lastProjection: ImageProjectionStats = {
    inputImages: 0, preparedImages: 0, sentImages: 0, sentBytes: 0, omittedHistorical: 0, omittedBudget: 0,
  }

  async function project<T extends { role?: unknown; content?: unknown }>(
    messages: T[],
    internalUserPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    checkAbort(signal)
    const stats: ImageProjectionStats = {
      inputImages: 0, preparedImages: 0, sentImages: 0, sentBytes: 0, omittedHistorical: 0, omittedBudget: 0,
    }
    const deadline = Date.now() + limits.maxPreparationMs
    const replacements = new Map<number, Map<number, ImageContent | { type: 'text'; text: string }>>()
    const replace = (candidate: ImageCandidate, text: string): void => {
      let blocks = replacements.get(candidate.messageIndex)
      if (!blocks) {
        blocks = new Map()
        replacements.set(candidate.messageIndex, blocks)
      }
      blocks.set(candidate.blockIndex, { type: 'text', text })
    }

    // 业务轮次边界：内部压缩续接不算新的用户任务，不能因此把旧图当作"本轮附件"。
    const latestUser = findLatestExplicitUserIndex(messages, internalUserPrompt)

    const attachments: ImageCandidate[] = []
    const toolImages: ImageCandidate[] = []
    let keySeq = 0
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      checkAbort(signal)
      const message = messages[messageIndex]!
      if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content)) continue
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block: unknown = message.content[blockIndex]
        if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image') continue
        stats.inputImages++
        const candidate: ImageCandidate = {
          messageIndex,
          blockIndex,
          block: block as ImageContent,
          key: `${messageIndex}:${blockIndex}:${keySeq++}`,
        }
        if (messageIndex < latestUser) {
          // 不读 base64、不估算字节；直接标记省略，保持工具关联与原始附件不变。
          stats.omittedHistorical++
          replace(candidate, HISTORICAL_IMAGE_NOTE)
        } else if (message.role === 'user') attachments.push(candidate)
        else toolImages.push(candidate)
      }
    }

    // 为最新工具视觉证据预留少量槽位，避免一组附件让之后的核验图永久饥饿。
    // 其余按「本轮用户附件优先、工具图其次」参与预算，输出仍按原消息顺序组装。
    toolImages.reverse()
    const freshSlots = Math.min(
      toolImages.length,
      limits.maxRequestImages,
      Math.max(1, Math.floor(limits.maxRequestImages / 3)),
    )
    const candidates = [...toolImages.slice(0, freshSlots), ...attachments, ...toolImages.slice(freshSlots)]

    for (const candidate of candidates) {
      checkAbort(signal)
      if (
        stats.sentImages >= limits.maxRequestImages
        || stats.sentBytes >= limits.maxRequestBytes
        || stats.preparedImages >= limits.maxPreparedImages
        || Date.now() >= deadline
      ) {
        stats.omittedBudget++
        replace(candidate, BUDGET_IMAGE_NOTE)
        continue
      }
      stats.preparedImages++
      const bytes = estimateBlockBytes(candidate.block)
      if (bytes === undefined) {
        // 非 image/* 或数据结构异常：交给 Pi 的校验处理，这里不额外替换。
        stats.preparedImages--
        continue
      }
      if (stats.sentBytes + bytes > limits.maxRequestBytes) {
        stats.omittedBudget++
        replace(candidate, BUDGET_IMAGE_NOTE)
        continue
      }
      stats.sentImages++
      stats.sentBytes += bytes
    }

    const projected = messages.map((message, index) => {
      const blocks = replacements.get(index)
      if (!blocks || !Array.isArray(message.content)) return message
      let changed = false
      const content = message.content.map((block: unknown, blockIndex: number) => {
        const replacement = blocks.get(blockIndex)
        changed ||= replacement !== undefined && replacement !== block
        return replacement ?? block
      })
      return changed ? { ...message, content } : message
    })
    checkAbort(signal)
    lastProjection = stats
    return projected
  }

  return {
    project,
    getLastProjectionStats: (): ImageProjectionStats => ({ ...lastProjection }),
    getLimits: (): ImageRequestBudgetLimits => ({ ...limits }),
  }
}
