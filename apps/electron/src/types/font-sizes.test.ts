import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FONT_SIZES,
  FONT_SIZE_AXES,
  clampFontSize,
  resolveFontSizes,
} from './settings'

describe('全局字号轴', () => {
  test('Given 越界或非法值 When clamp Then 收敛到轴范围或默认值', () => {
    expect(clampFontSize('content', 99)).toBe(FONT_SIZE_AXES.content.max)
    expect(clampFontSize('content', 1)).toBe(FONT_SIZE_AXES.content.min)
    expect(clampFontSize('content', 15.6)).toBe(16)
    expect(clampFontSize('content', Number.NaN)).toBe(FONT_SIZE_AXES.content.default)
    expect(clampFontSize('code', undefined)).toBe(FONT_SIZE_AXES.code.default)
  })

  test('Given 缺失字段 When resolve Then 使用 15/12/14 默认值', () => {
    expect(resolveFontSizes()).toEqual(DEFAULT_FONT_SIZES)
    expect(DEFAULT_FONT_SIZES).toEqual({ content: 15, code: 12, terminal: 14 })
  })

  test('Given 用户覆盖 When resolve Then 逐轴 clamp', () => {
    expect(resolveFontSizes({
      contentFontSize: 18,
      codeFontSize: 99,
      terminalFontSize: 9,
    })).toEqual({ content: 18, code: 16, terminal: 10 })
  })
})
