import { describe, expect, test } from 'bun:test'
import { shouldUseCompactToc } from './markdown-toc-layout'

describe('Markdown 目录容器布局', () => {
  test.each([360, 480, 639, 0, undefined, Number.NaN])('Given 窄或未测量容器 %s When 选择目录 Then 不占固定侧栏宽度', (width) => {
    expect(shouldUseCompactToc(width)).toBe(true)
  })
  test.each([640, 800, 1200])('Given 足够宽容器 %s When 选择目录 Then 保留侧栏', (width) => {
    expect(shouldUseCompactToc(width)).toBe(false)
  })
})
