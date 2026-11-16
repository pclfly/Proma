/**
 * 紧凑单栏布局判定（官方 0.22.60）。
 *
 * 窗口宽度收到手机尺寸时切换为单栏，只影响本次渲染；桌面宽度、折叠偏好
 * 与原生浏览器状态不被写回，放大窗口后恢复原布局。
 */

export const COMPACT_SHELL_BREAKPOINT = 640

export type ShellLayoutMode = 'desktop' | 'compact'

export function resolveShellLayoutMode(viewportWidth: number): ShellLayoutMode {
  if (!Number.isFinite(viewportWidth)) return 'desktop'
  return viewportWidth <= COMPACT_SHELL_BREAKPOINT ? 'compact' : 'desktop'
}
