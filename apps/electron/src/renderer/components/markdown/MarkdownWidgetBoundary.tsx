import * as React from 'react'

/** 独立 createRoot 的 widget 必须拥有自己的边界，外层预览边界无法跨 root 捕获。 */
export class MarkdownWidgetBoundary extends React.Component<{ source: string; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(error: unknown): void { console.warn('[Markdown] 块预览失败，显示源码:', error) }
  override render(): React.ReactNode {
    return this.state.failed
      ? <pre className="whitespace-pre-wrap break-words p-3 text-sm" role="note">{this.props.source}</pre>
      : this.props.children
  }
}
