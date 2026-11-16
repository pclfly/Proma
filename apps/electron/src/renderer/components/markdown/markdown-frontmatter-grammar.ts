import type { MarkdownConfig } from '@lezer/markdown'

/**
 * 将首部YAML作为不含Markdown子节点的原文块解析。这样源码模式里注释、星号、
 * 列表dash不会被ink-mde的Heading/List/Emphasis装饰器替换；正文从结束围栏后正常解析。
 * 尚未闭合的首部区域也仅显示原文，不猜测其内部Markdown含义。
 */
export const markdownFrontmatterGrammar: MarkdownConfig = {
  defineNodes: ['YamlFrontmatter'],
  parseBlock: [{
    name: 'YamlFrontmatter',
    before: 'HorizontalRule',
    parse: (context, line) => {
      if (context.lineStart !== 0 || !/^(?:\uFEFF)?---[ \t]*$/.test(line.text)) return false
      const from = context.lineStart
      let to = from + line.text.length
      while (context.nextLine()) {
        to = context.lineStart + line.text.length
        if (/^---[ \t]*$/.test(line.text)) { context.nextLine(); break }
      }
      context.addElement(context.elt('YamlFrontmatter', from, to))
      return true
    },
  }],
}
