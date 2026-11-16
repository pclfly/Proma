import { describe, expect, test } from 'bun:test'
import { resolveWindowCreationBounds } from './main-window-lifecycle'

const WORK_AREA = { x: 0, y: 0, width: 2560, height: 1400 }
const identity = (bounds: { width: number; height: number; x: number; y: number }) => bounds
const FALLBACK = { width: 1400, height: 900 }

describe('启动页创建尺寸', () => {
  test('Given 上次最大化退出 When 创建启动页 Then 直接用工作区尺寸而不是保存的小窗口', () => {
    const bounds = resolveWindowCreationBounds({
      savedState: { width: 944, height: 600, x: 26, y: 6, isMaximized: true },
      workArea: WORK_AREA,
      normalizeVisible: identity,
      fallbackSize: FALLBACK,
    })

    expect(bounds).toEqual({ x: 0, y: 0, width: 2560, height: 1400 })
  })

  test('Given 首次启动 When 创建启动页 Then 默认覆盖工作区', () => {
    const bounds = resolveWindowCreationBounds({
      savedState: undefined,
      workArea: WORK_AREA,
      normalizeVisible: identity,
      fallbackSize: FALLBACK,
    })

    expect(bounds).toEqual({ x: 0, y: 0, width: 2560, height: 1400 })
  })

  test('Given 上次普通窗口退出 When 创建启动页 Then 沿用规范化后的保存尺寸', () => {
    const bounds = resolveWindowCreationBounds({
      savedState: { width: 1200, height: 800, x: 40, y: 20, isMaximized: false },
      workArea: WORK_AREA,
      normalizeVisible: identity,
      fallbackSize: FALLBACK,
    })

    expect(bounds).toEqual({ x: 40, y: 20, width: 1200, height: 800 })
  })

  test('Given 显示器工作区不可用 When 最大化启动 Then 退回规范化保存尺寸', () => {
    const bounds = resolveWindowCreationBounds({
      savedState: { width: 1200, height: 800, x: 40, y: 20, isMaximized: true },
      workArea: { x: Number.NaN, y: 0, width: 0, height: 0 },
      normalizeVisible: identity,
      fallbackSize: FALLBACK,
    })

    expect(bounds).toEqual({ x: 40, y: 20, width: 1200, height: 800 })
  })
})
