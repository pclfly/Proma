import type { MarkdownTokenLike } from './custom-markdown-types'

/** 读取 markdown-it token 的属性值（markdown-it 用 [name, value] 元组存属性） */
export function getTokenAttr(token: MarkdownTokenLike, name: string): string | number | undefined {
  if (!token.attrs) return undefined
  for (const [attrName, value] of token.attrs) {
    if (attrName === name) return value
  }
  return undefined
}

/** 读取字符串属性；非字符串值统一忽略，避免把数字塞进 href/src */
export function getTokenStringAttr(token: MarkdownTokenLike, name: string): string | undefined {
  const value = getTokenAttr(token, name)
  return typeof value === 'string' ? value : undefined
}