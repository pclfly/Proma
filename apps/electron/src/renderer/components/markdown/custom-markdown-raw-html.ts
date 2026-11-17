/**
 * 原始 HTML 检测。
 *
 * 自研管线用 `html: false` 解析，markdown-it 不会产出 html_block / html_inline，
 * 也不会把任何标签当 HTML 执行。这样虽然安全，但标签内的换行、属性等细节会与
 * 现有 react-markdown（未启用 rehype-raw，原始 HTML 按字面量转义展示）不完全一致。
 * 因此解析前先做一次检测，命中则整条消息回退到 react-markdown。
 */

/** 常见 HTML 标签名白名单：只对真正的标签触发回退，避免 `List<String>` 这类尖括号文本误判。 */
const RAW_HTML_TAG_NAMES = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote',
  'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'link', 'main', 'mark', 'marquee', 'math', 'menu', 'meta', 'nav', 'noscript',
  'object', 'ol', 'option', 'p', 'param', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'script', 'section', 'select', 'small', 'source', 'span', 'strike', 'strong',
  'style', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea',
  'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
])

const TAG_PATTERN = /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^<>]*>/g

/** 去掉围栏代码块与行内代码，避免代码里的标签字面量触发回退。 */
function stripCodeSegments(source: string): string {
  const output: string[] = []
  let fence: string | null = null

  for (const line of source.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!
      continue
    }
    output.push(line.replace(/(`+)[\s\S]*?\1/g, ' '))
  }

  return output.join('\n')
}

/** 源码是否含原始 HTML（注释、声明、白名单标签）。 */
export function containsRawHtml(source: string): boolean {
  if (!source.includes('<')) return false

  const text = stripCodeSegments(source)
  if (text.includes('<!--')) return true
  // <!DOCTYPE>、<![CDATA[>、<?xml ...?> 这类声明同样交给 react-markdown 处理
  if (/<[!?]/.test(text)) return true

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const tagName = match[1]?.toLowerCase()
    if (tagName && RAW_HTML_TAG_NAMES.has(tagName)) return true
  }
  return false
}