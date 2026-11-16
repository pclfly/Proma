/**
 * 表格单元格与 Callout 共用的 Vault 双链内联渲染。
 *
 * 输出为可点击的 span + data 属性而不是 `<button>`：表格单元格本身在可编辑态
 * 已经是 button，嵌套交互元素会产生无效 HTML。点击由外层容器做事件委托。
 */
import type MarkdownIt from 'markdown-it'

interface InlineWikiLinkMeta {
  target: string
  label: string
}

/** 只接受可由 resolveVaultWikiLink 解析的普通笔记目标；标题/块引用保持原文。 */
const TARGET_PATTERN = /^\[\[([^[\]\n|#^:]+)(?:\|([^[\]\n]+))?\]\]/

export function installInlineVaultWikiLinks(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('escape', 'vault_wikilink', (state, silent) => {
    // 由调用方通过 env 显式开启：非 Vault 宿主保持字面文本。
    const env = state.env as { vaultWikiLinks?: boolean } | undefined
    if (!env?.vaultWikiLinks) return false
    if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false
    if (state.src.charCodeAt(state.pos + 1) !== 0x5b) return false
    // Obsidian 嵌入语法 ![[...]] 属于图片/嵌入，不在阅读态转成链接。
    if (state.pos > 0 && state.src[state.pos - 1] === '!') return false
    const match = state.src.slice(state.pos, state.posMax).match(TARGET_PATTERN)
    if (!match) return false
    const target = match[1]!.trim()
    if (!target) return false
    if (!silent) {
      const token = state.push('vault_wikilink', '', 0)
      // 自定义规则早于实体解析，需显式解码一次，否则 &lt; 会被二次转义成 &amp;lt;。
      const label = markdown.utils.unescapeAll(match[2]?.trim() || target)
      const meta: InlineWikiLinkMeta = { target: markdown.utils.unescapeAll(target), label }
      token.meta = meta
      token.content = meta.label
    }
    state.pos += match[0].length
    return true
  })

  markdown.renderer.rules.vault_wikilink = (tokens, index) => {
    const meta = tokens[index]?.meta as InlineWikiLinkMeta | undefined
    if (!meta) return ''
    return `<span class="vault-wikilink-inline" role="link" data-vault-wikilink-target="${markdown.utils.escapeHtml(meta.target)}">${markdown.utils.escapeHtml(meta.label)}</span>`
  }
}
