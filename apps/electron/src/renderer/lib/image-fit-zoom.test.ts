import { describe, expect, test } from 'bun:test'
import { computeImageFitZoom } from './image-fit-zoom'

describe('预览面板图片自适应缩放', () => {
  test('Given 大图超出容器 When 计算 When 等比缩小到整图可见', () => {
    expect(computeImageFitZoom({
      availableWidth: 400,
      availableHeight: 700,
      naturalWidth: 1920,
      naturalHeight: 1080,
    })).toBe(0.21)
  })

  test('Given 容器高度是瓶颈 When 计算 Then 按高度适配', () => {
    expect(computeImageFitZoom({
      availableWidth: 1200,
      availableHeight: 300,
      naturalWidth: 1000,
      naturalHeight: 1000,
    })).toBe(0.3)
  })

  test('Given 小图放得下 When 计算 Then 不放大超过 100%', () => {
    expect(computeImageFitZoom({
      availableWidth: 900,
      availableHeight: 900,
      naturalWidth: 120,
      naturalHeight: 80,
    })).toBe(1)
  })

  test('Given 图片或容器尺寸未知 When 计算 Then 返回 null 交由调用方保持现状', () => {
    expect(computeImageFitZoom({ availableWidth: 0, availableHeight: 700, naturalWidth: 800, naturalHeight: 600 })).toBeNull()
    expect(computeImageFitZoom({ availableWidth: 400, availableHeight: 700, naturalWidth: 0, naturalHeight: 600 })).toBeNull()
  })

  test('Given 极窄容器 When 计算 Then 不低于最小缩放', () => {
    expect(computeImageFitZoom({
      availableWidth: 20,
      availableHeight: 700,
      naturalWidth: 4000,
      naturalHeight: 3000,
    })).toBe(0.1)
  })
})
