/** 全局字号：内容/代码/终端三条轴，由主进程菜单快捷键步进并广播。 */
import { atom } from 'jotai'
import { DEFAULT_FONT_SIZES, clampFontSize, type AppFontSizes } from '../../types'

export const fontSizesAtom = atom<AppFontSizes>({ ...DEFAULT_FONT_SIZES })

function normalize(input?: Partial<AppFontSizes>): AppFontSizes {
  return {
    content: clampFontSize('content', input?.content),
    code: clampFontSize('code', input?.code),
    terminal: clampFontSize('terminal', input?.terminal),
  }
}

export function applyFontSizesToDOM(sizes: AppFontSizes): void {
  const root = document.documentElement
  root.style.setProperty('--content-font-size', `${sizes.content}px`)
  root.style.setProperty('--code-font-size', `${sizes.code}px`)
  root.style.setProperty('--terminal-font-size', `${sizes.terminal}px`)
  root.style.setProperty('--reading-font-size-offset', `${sizes.content - DEFAULT_FONT_SIZES.content}px`)
}

/** 首帧同步读取，随后订阅主进程广播；返回取消订阅函数。 */
export function initializeFontSizes(setSizes: (sizes: AppFontSizes) => void): () => void {
  const initial = normalize(window.electronAPI.getFontSettingsSync())
  setSizes(initial)
  applyFontSizesToDOM(initial)
  return window.electronAPI.onFontSettingsChanged((sizes) => {
    const next = normalize(sizes)
    setSizes(next)
    applyFontSizesToDOM(next)
  })
}
