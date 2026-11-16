import { describe, expect, test } from 'bun:test'
import type { Model, ModelImageResizeOptions } from '@earendil-works/pi-ai'
import { MODEL_IMAGE_RESIZE_OPTIONS, withPromaImageInputLimits } from './model-image-compression'

type TestModel = Pick<Model<string>, 'inputLimits'>

function makeModel(resize?: Partial<ModelImageResizeOptions>): TestModel {
  return {
    inputLimits: resize ? { images: { resize } } : undefined,
  }
}

describe('官方对齐的图片输入限制', () => {
  test('Given 官方取值 When 读取常量 Then 与 0.21.88 产物一致', () => {
    expect(MODEL_IMAGE_RESIZE_OPTIONS).toEqual({
      maxWidth: 1568,
      maxHeight: 1568,
      maxBytes: 1e6,
      jpegQuality: 85,
    })
  })

  test('Given 模型无 inputLimits When 合并 Then 注入官方上限', () => {
    const merged = withPromaImageInputLimits(makeModel())
    expect(merged.inputLimits?.images?.resize).toEqual(MODEL_IMAGE_RESIZE_OPTIONS)
  })

  test('Given 模型自带更小上限 When 合并 Then 保留更严格的值而不放宽', () => {
    const merged = withPromaImageInputLimits(
      makeModel({ maxWidth: 1024, maxHeight: 1024, maxBytes: 500_000, jpegQuality: 70 }),
    )
    expect(merged.inputLimits?.images?.resize).toEqual({
      maxWidth: 1024,
      maxHeight: 1024,
      maxBytes: 500_000,
      jpegQuality: 70,
    })
  })

  test('Given 模型自带更大上限 When 合并 Then 收紧到官方上限', () => {
    const merged = withPromaImageInputLimits(
      makeModel({ maxWidth: 4096, maxHeight: 4096, maxBytes: 8_000_000, jpegQuality: 95 }),
    )
    expect(merged.inputLimits?.images?.resize).toEqual(MODEL_IMAGE_RESIZE_OPTIONS)
  })

  test('Given 模型只声明部分字段 When 合并 Then 缺失项用官方值补齐', () => {
    const merged = withPromaImageInputLimits(makeModel({ maxWidth: 800 }))
    expect(merged.inputLimits?.images?.resize).toEqual({
      maxWidth: 800,
      maxHeight: 1568,
      maxBytes: 1e6,
      jpegQuality: 85,
    })
  })

  test('Given 模型已有其它 inputLimits 字段 When 合并 Then 其它字段不丢失', () => {
    const model: Pick<Model<string>, 'inputLimits'> = {
      inputLimits: { maxRequestBytes: 12_000_000, images: { maxPerRequest: 12 } },
    }
    const merged = withPromaImageInputLimits(model)
    expect(merged.inputLimits?.maxRequestBytes).toBe(12_000_000)
    expect(merged.inputLimits?.images?.maxPerRequest).toBe(12)
    expect(merged.inputLimits?.images?.resize).toEqual(MODEL_IMAGE_RESIZE_OPTIONS)
  })

  test('Given 合并前后 When 比较 Then 不修改原模型对象', () => {
    const original = makeModel({ maxWidth: 1024 })
    const snapshot = JSON.stringify(original)
    withPromaImageInputLimits(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  test('Given base64 语义 When 校验上限 Then 1e6 对应约 750KB 原始字节', () => {
    // Pi 用 Math.ceil(byteLength / 3) * 4 估算 base64 长度；这里固定该换算关系。
    const bytes = 750_000
    const base64Size = Math.ceil(bytes / 3) * 4
    expect(base64Size).toBeLessThanOrEqual(MODEL_IMAGE_RESIZE_OPTIONS.maxBytes)
  })
})
