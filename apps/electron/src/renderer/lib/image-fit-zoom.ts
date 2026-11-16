/**
 * 图片预览的自适应缩放。
 *
 * 预览面板以前固定默认 25%，在常见截图（1~2K 宽）下只有两三百像素，几乎看不清；
 * 改为「整图可见」的自适应比例：按容器可用空间等比缩小，最多 100%（不放大）。
 */

/** 缩放下限，防止极端窄面板把图压成一个点 */
const MIN_ZOOM = 0.1
/** 缩放上限，与手动放大的上限保持一致 */
const MAX_ZOOM = 5
/** 默认（尚未算出自适应比例时）的缩放，避免先按实际尺寸铺满再突然缩小 */
export const DEFAULT_IMAGE_ZOOM = 1

/**
 * 计算恰好放得下整图的缩放比例。
 * 任一尺寸缺失（图片未加载、容器未布局）时返回 null，由调用方保持现状。
 */
export function computeImageFitZoom(input: {
  availableWidth: number
  availableHeight: number
  naturalWidth: number
  naturalHeight: number
}): number | null {
  const { availableWidth, availableHeight, naturalWidth, naturalHeight } = input
  if (naturalWidth <= 0 || naturalHeight <= 0) return null
  if (availableWidth <= 0 || availableHeight <= 0) return null
  const fit = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight, 1)
  // 保留两位小数：百分比读数稳定，也不会让 ResizeObserver 反复写入相近值
  const rounded = Math.round(fit * 100) / 100
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rounded))
}
