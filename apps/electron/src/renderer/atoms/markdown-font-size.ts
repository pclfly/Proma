/** 统一阅读字号：会话列表、输入区和 Markdown 使用同一个 CSS 变量。 */
import { atom } from 'jotai'
import { DEFAULT_MARKDOWN_FONT_SIZE, isMarkdownFontSize } from '../../types'
import type { MarkdownFontSize } from '../../types'

const FONT_SIZE_PX: Record<MarkdownFontSize, number> = { small: 13, medium: 15, large: 17 }
export const markdownFontSizeAtom = atom<MarkdownFontSize>(DEFAULT_MARKDOWN_FONT_SIZE)

// 保护异步初始化：用户在首个读取返回前选择字号时，旧快照不能覆盖本地选择。
let localPreferenceRevision = 0

export function applyMarkdownFontSizeToDOM(size: MarkdownFontSize): void {
  const validSize = isMarkdownFontSize(size) ? size : DEFAULT_MARKDOWN_FONT_SIZE
  document.documentElement.style.setProperty('--md-preview-font-size', `${FONT_SIZE_PX[validSize]}px`)
}

/** 先订阅再读取；同步返回清理函数，StrictMode/卸载无需等待 IPC 返回。 */
export function initializeMarkdownFontSize(setSize: (size: MarkdownFontSize) => void): () => void {
  let active = true
  let receivedUpdate = false
  const revision = localPreferenceRevision
  const apply = (size: MarkdownFontSize) => { setSize(size); applyMarkdownFontSizeToDOM(size) }
  const unsubscribe = window.electronAPI.onReadingSettingsChanged((event) => {
    if (!active || !isMarkdownFontSize(event.markdownFontSize)) return
    receivedUpdate = true
    apply(event.markdownFontSize)
  })
  const canApplyInitial = () => active && !receivedUpdate && revision === localPreferenceRevision
  void window.electronAPI.getSettings().then((settings) => {
    if (canApplyInitial()) apply(isMarkdownFontSize(settings.markdownFontSize) ? settings.markdownFontSize : DEFAULT_MARKDOWN_FONT_SIZE)
  }).catch((error: unknown) => {
    console.error('[阅读字号] 初始化失败:', error)
    if (canApplyInitial()) apply(DEFAULT_MARKDOWN_FONT_SIZE)
  })
  return () => {
    if (!active) return
    active = false
    unsubscribe()
  }
}

/** 本地即时预览；保存成功后的广播同步 atom 和其它已打开窗口。 */
export async function updateMarkdownFontSize(size: MarkdownFontSize): Promise<void> {
  if (!isMarkdownFontSize(size)) return
  localPreferenceRevision += 1
  applyMarkdownFontSizeToDOM(size)
  try {
    await window.electronAPI.updateSettings({ markdownFontSize: size })
  } catch (error) {
    console.error('[阅读字号] 持久化失败:', error)
  }
}
