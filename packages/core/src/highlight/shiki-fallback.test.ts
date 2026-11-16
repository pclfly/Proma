import { describe, expect, test } from 'bun:test'
import { highlightCode, highlightToTokens } from './shiki-service'

describe('高亮异常的源码兜底', () => {
  test('Given 旧文本成功高亮 When 新文本高亮抛错 Then 返回当前源码而不是旧tokens', async () => {
    await highlightCode({ code: 'OLD', language: 'text' })
    expect(highlightToTokens({ code: 'OLD', language: 'text' })).not.toBeNull()
    for (const code of ['NEW', 'N', 'NEW\nLONGER']) {
      const result = highlightToTokens({ code, language: 'text', theme: 'missing-test-theme' })
      expect(result?.lines.map(line => line.map(token => token.content).join('')).join('\n')).toBe(code)
    }
  })
})
