import type { Model, ModelImageResizeOptions } from '@earendil-works/pi-ai'

/**
 * 图片输入限制：与官方 0.21.88 的 `src/main/lib/model-image-compression.ts` 对齐。
 *
 * 官方不自己做每轮请求投影，而是把上限合并进模型定义，
 * 由 Pi SDK 在「新图片进入会话」时压缩一次：
 * - 用户新发送的图片：`AgentSession._normalizePromptImages()`
 * - 工具返回的图片：`normalizeToolResultImages()`
 *
 * `maxBytes` 的语义是 **base64 编码后的字节数**，不是原始二进制字节。
 * Pi SDK 的 `image-resize-core.ts` 用 `Math.ceil(byteLength / 3) * 4` 比较。
 *
 * 已存在于历史中的图片不会被回溯压缩，这与官方行为一致。
 */

/** 官方取值；声明为必填常量，避免下游使用处遇到 undefined。 */
export const MODEL_IMAGE_RESIZE_OPTIONS: Required<ModelImageResizeOptions> = {
  maxWidth: 1568,
  maxHeight: 1568,
  maxBytes: 1e6,
  jpegQuality: 85,
}

/** 模型自带的更严格限制优先，避免放宽渠道本身的约束。 */
function minDefined(current: number | undefined, limit: number | undefined): number | undefined {
  if (limit === undefined) return current
  return current === undefined ? limit : Math.min(current, limit)
}

/**
 * 把官方上限合并进模型 `inputLimits.images.resize`。
 *
 * 只收紧不放宽：渠道/模型已声明更小的值时就保留更小的值。
 * 返回新对象，不修改入参。
 */
export function withPromaImageInputLimits<T extends Pick<Model<string>, 'inputLimits'>>(model: T): T {
  const existing = model.inputLimits?.images?.resize
  const resize: ModelImageResizeOptions = {
    maxWidth: minDefined(existing?.maxWidth, MODEL_IMAGE_RESIZE_OPTIONS.maxWidth),
    maxHeight: minDefined(existing?.maxHeight, MODEL_IMAGE_RESIZE_OPTIONS.maxHeight),
    maxBytes: minDefined(existing?.maxBytes, MODEL_IMAGE_RESIZE_OPTIONS.maxBytes),
    jpegQuality: minDefined(existing?.jpegQuality, MODEL_IMAGE_RESIZE_OPTIONS.jpegQuality),
  }
  return {
    ...model,
    inputLimits: {
      ...model.inputLimits,
      images: { ...model.inputLimits?.images, resize },
    },
  }
}
