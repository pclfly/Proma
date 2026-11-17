import { describe, expect, test } from 'bun:test'
import {
  canReuseStreamingTokens,
  createStreamingHighlightCache,
  highlightStreamingCode,
  isStatefulLanguage,
} from './streaming-highlight'
import type { HighlightOptions, HighlightTokensResult } from './shiki-service'

/**
 * 可观测的假高亮器：每次调用给所有 token 打上 call-N 颜色，
 * 便于断言「哪些行复用了旧结果、哪些行被重新高亮」。
 */
function createProbeTokenizer(): {
  tokenize: (options: HighlightOptions) => HighlightTokensResult
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    tokenize: (options: HighlightOptions): HighlightTokensResult => {
      calls.push(options.code)
      const color = `call-${calls.length}`
      return {
        lines: options.code.split('\n').map((line) => (line ? [{ content: line, color }] : [])),
        bgColor: '#000000',
        fgColor: '#ffffff',
        language: options.language,
      }
    },
  }
}

describe('canReuseStreamingTokens 策略', () => {
  test('Given 追加式变更 When 语言无跨行状态 Then 允许复用', () => {
    expect(canReuseStreamingTokens('line1\n', 'line1\nline2', 'text', 'github-dark')).toBe(true)
    expect(canReuseStreamingTokens('line1\nline', 'line1\nline2', 'text', 'github-dark')).toBe(true)
  })

  test('Given 非追加式变更 When 编辑既有行 Then 拒绝复用', () => {
    expect(canReuseStreamingTokens('const a = 1', 'const b = 2', 'typescript', 'github-dark')).toBe(false)
    expect(canReuseStreamingTokens('line1\nline2', 'line1\nLINE2', 'text', 'github-dark')).toBe(false)
    expect(canReuseStreamingTokens('line1\nline2', 'line1\n', 'text', 'github-dark')).toBe(false)
  })

  test('Given 相同代码 When 重复请求 Then 允许复用', () => {
    expect(canReuseStreamingTokens('line1\nline2', 'line1\nline2', 'typescript', 'github-dark')).toBe(true)
  })

  test('Given stateful 语言尾行未完成 When 追加含换行 Then 拒绝复用（避免冻结尾行）', () => {
    expect(canReuseStreamingTokens('const a = 1', 'const a = 1\nconst b = 2', 'typescript', 'github-dark')).toBe(false)
    expect(canReuseStreamingTokens('const s = `a', 'const s = `a\nb`', 'tsx', 'github-dark')).toBe(false)
  })

  test('Given stateful 语言 When 旧代码没有完整行 Then 拒绝复用', () => {
    expect(canReuseStreamingTokens('const a', 'const a = 1', 'javascript', 'github-dark')).toBe(false)
    expect(canReuseStreamingTokens('', 'const a = 1', 'javascript', 'github-dark')).toBe(false)
  })

  test('Given stateful 语言 When 追加不含换行且存在完整行 Then 允许复用', () => {
    expect(canReuseStreamingTokens('const a = 1\n', 'const a = 1\nconst b', 'typescript', 'github-dark')).toBe(true)
    expect(canReuseStreamingTokens('const a = 1\nconst b', 'const a = 1\nconst b = 2', 'typescript', 'github-dark')).toBe(true)
  })

  test('Given 语言标记 When 查询 stateful Then 未知语言保守归类', () => {
    expect(isStatefulLanguage('text')).toBe(false)
    expect(isStatefulLanguage('diff')).toBe(false)
    expect(isStatefulLanguage('typescript')).toBe(true)
    expect(isStatefulLanguage('md')).toBe(true)
    expect(isStatefulLanguage('some-unknown-lang')).toBe(true)
  })
})

describe('流式增量高亮', () => {
  test('Given 追加一行 When 高亮 Then 旧完整行 token 复用且新行正确', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    const first = highlightStreamingCode(cache, { code: 'line1\n', language: 'text' })
    const second = highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })

    expect(calls).toEqual(['line1\n', 'line2'])
    expect(second?.lines).toHaveLength(2)
    // 第一行是同一份 token 数组（引用复用），第二行来自新的高亮调用
    expect(second?.lines[0]).toBe(first?.lines[0])
    expect(second?.lines[1]?.[0]?.color).toBe('call-2')
  })

  test('Given stateful 语言追加同行内容 When 高亮 Then 复用完整行、尾行暂不着色', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    const first = highlightStreamingCode(cache, { code: 'const a = 1\nconst b', language: 'typescript' })
    const second = highlightStreamingCode(cache, { code: 'const a = 1\nconst b = 2', language: 'typescript' })

    // 未完成尾行不再独立 token 化，避免显示与全量语法状态不符的颜色。
    expect(calls).toEqual(['const a = 1\nconst b'])
    expect(second?.lines[0]).toBe(first?.lines[0])
    expect(second?.lines[1]?.[0]?.content).toBe('const b = 2')
    expect(second?.lines[1]?.[0]?.color).toBeUndefined()

    const third = highlightStreamingCode(cache, { code: 'const a = 1\nconst b = 2\n', language: 'typescript' })
    expect(calls).toHaveLength(2)
    expect(third?.lines[1]?.[0]?.color).toBe('call-2')
  })

  test('Given 相同代码重复请求 When 高亮 Then 命中缓存返回同一结果对象', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    const first = highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })
    const second = highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })

    expect(calls).toHaveLength(1)
    expect(second).toBe(first)
  })

  test('Given 修改已有行 When 高亮 Then 全量重算', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })
    const edited = highlightStreamingCode(cache, { code: 'line1\nLINE2', language: 'text' })

    expect(calls).toEqual(['line1\nline2', 'line1\nLINE2'])
    expect(edited?.lines[0]?.[0]?.color).toBe('call-2')
    expect(edited?.lines[1]?.[0]?.color).toBe('call-2')
  })

  test('Given 语言切换 When 高亮 Then 缓存键失效并全量重算', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })
    const switched = highlightStreamingCode(cache, { code: 'line1\nline2', language: 'typescript' })

    expect(calls).toEqual(['line1\nline2', 'line1\nline2'])
    expect(switched?.lines[0]?.[0]?.color).toBe('call-2')
    expect(cache.size).toBe(2)
  })

  test('Given 主题切换 When 高亮 Then 缓存键失效并全量重算', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text', theme: 'github-dark' })
    const switched = highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text', theme: 'one-dark-pro' })

    expect(calls).toHaveLength(2)
    expect(switched?.lines[0]?.[0]?.color).toBe('call-2')
  })

  test('Given stateful 语言尾行未完成 When 追加含换行 Then 不使用可能错误的复用', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'const s = `a', language: 'typescript' })
    const next = highlightStreamingCode(cache, { code: 'const s = `a\nb`', language: 'typescript' })

    // 全量重算：旧行的 token 处于跨行字符串状态，不能冻结成完整行复用
    expect(calls).toEqual(['const s = `a', 'const s = `a\nb`'])
    expect(next?.lines[0]?.[0]?.color).toBe('call-2')
    expect(next?.lines[1]?.[0]?.color).toBe('call-2')
  })

  test('Given stateful 语言首行尚未结束 When 追加 Then 全量重算', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'const a', language: 'typescript' })
    highlightStreamingCode(cache, { code: 'const a = 1', language: 'typescript' })

    expect(calls).toEqual(['const a', 'const a = 1'])
  })

  test('Given 高亮器未就绪 When 高亮返回 null Then 不写入缓存', () => {
    const cache = createStreamingHighlightCache({ tokenize: () => null })

    expect(highlightStreamingCode(cache, { code: 'line1', language: 'text' })).toBeNull()
    expect(cache.size).toBe(0)
  })

  test('Given 超大代码 When 连续高亮 Then 缓存不无限增长', () => {
    const { tokenize } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({
      tokenize,
      maxEntries: 2,
      maxCodeLength: 64,
      maxTotalCodeLength: 128,
    })

    const hugeLine = 'x'.repeat(200)
    for (let i = 0; i < 20; i += 1) {
      highlightStreamingCode(cache, { code: `${hugeLine}${'y'.repeat(i)}`, language: 'text' })
    }
    expect(cache.size).toBe(0)

    for (const language of ['text', 'json', 'python', 'go', 'rust']) {
      highlightStreamingCode(cache, { code: `line1\nline2-${language}`, language })
    }
    expect(cache.size).toBeLessThanOrEqual(2)
  })

  test('Given 缓存清空 When 再次高亮 Then 重新全量计算', () => {
    const { tokenize, calls } = createProbeTokenizer()
    const cache = createStreamingHighlightCache({ tokenize })

    highlightStreamingCode(cache, { code: 'line1\n', language: 'text' })
    cache.clear()
    highlightStreamingCode(cache, { code: 'line1\nline2', language: 'text' })

    expect(calls).toEqual(['line1\n', 'line1\nline2'])
    expect(cache.size).toBe(1)
  })
})