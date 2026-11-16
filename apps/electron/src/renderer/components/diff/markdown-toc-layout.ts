/** 保证目录和正文能并排容纳；依据预览容器，而非窗口宽度。 */
export function shouldUseCompactToc(containerWidth: number | undefined): boolean {
  return containerWidth === undefined || !Number.isFinite(containerWidth) || containerWidth < 640
}
