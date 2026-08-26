export interface TabBarActionLayout {
  scrollPaddingClassName: string
  shortcutPositionClassName: string
  panelPositionClassName: string
}

/**
 * Tab 栏右侧所有 absolute 定位元素需与 WindowControls 保持明确间距，
 * 并提供 scroll padding 让 Tab 滚动区知道右侧预留宽度。
 *
 * Windows 上 WindowControls 总宽 = 36×3 + 4×2(gap) = 116px，
 * 容器位于 right-[10px]，所以最左按钮位于 right ≈ 10 + 116 = 126px。
 * panel button 位于 right-[140px]（与关闭按钮之间留 14px buffer）。
 * shortcut 按钮位于 right-[180px]（panel button 28px + 12px gap）。
 */
export function getTabBarActionLayout(isWindows: boolean, hasPanelButton: boolean, hasBrowserButton = false): TabBarActionLayout {
  if (!isWindows) {
    return {
      scrollPaddingClassName: hasPanelButton
        ? (hasBrowserButton ? 'pr-28' : 'pr-20')
        : (hasBrowserButton ? 'pr-20' : 'pr-10'),
      shortcutPositionClassName: hasPanelButton
        ? 'inset-y-0 items-end pb-[3px] z-10 right-9'
        : 'inset-y-0 items-end pb-[3px] z-10 right-1',
      panelPositionClassName: 'inset-y-0 right-1 items-end pb-[3px] z-10',
    }
  }

  return {
    // WindowControls 116px (right-[10px] 起) + 24px buffer + 28px panel button + 12px gap = 180px。
    // 加上快捷操作区 2×28 + 4px gap = 60px。
    scrollPaddingClassName: hasPanelButton
      ? (hasBrowserButton ? 'pr-[268px]' : 'pr-[240px]')
      : (hasBrowserButton ? 'pr-[240px]' : 'pr-[212px]'),
    shortcutPositionClassName: hasPanelButton
      ? 'inset-y-0 items-end pb-[3px] z-10 right-[180px]'
      : 'inset-y-0 items-end pb-[3px] z-10 right-[152px]',
    panelPositionClassName: 'inset-y-0 right-[140px] items-end pb-[3px] z-10',
  }
}
