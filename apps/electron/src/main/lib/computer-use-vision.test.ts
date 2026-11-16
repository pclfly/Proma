import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import type { ComputerUseVisionInput, ComputerUseVisionRegion } from '@proma/shared'
import {
  COMPUTER_USE_VISION_MAX_IMAGE_BYTES,
  ComputerUseVisionUnavailableError,
  createComputerUseVisionTools,
  createVisionDependencies,
  describeComputerUseVisionFailure,
  filterComputerUseVisionRegions,
  isComputerUseScreenshotPng,
  isComputerUseVisionFrameSizeMatched,
  isComputerUseVisionImageSizeAllowed,
  readComputerUseText,
  selectComputerUseVisionMatches,
  validateComputerUseVisionFrameSize,
  validateComputerUseVisionImage,
  validateComputerUseVisionInput,
  type ComputerUseVisionDependencies,
  type ComputerUseVisionObservation,
} from './computer-use-vision'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function region(
  text: string,
  x: number,
  y: number,
  confidence = 0.9,
): ComputerUseVisionRegion {
  return { text, confidence, bounds: { x, y, width: 10, height: 10 } }
}

function observation(regions: ComputerUseVisionRegion[]): ComputerUseVisionObservation {
  return { width: 800, height: 600, regions, captureId: 'cap-1', capturedAt: 100 }
}

const baseInput: ComputerUseVisionInput = { pid: 1, windowId: 2, session: 'session-1' }

describe('Computer Use OCR 图像与尺寸校验', () => {
  test('Given PNG 字节 When 校验 Then 通过', () => {
    expect(isComputerUseScreenshotPng(PNG)).toBe(true)
    expect(() => validateComputerUseVisionImage(PNG)).not.toThrow()
  })

  test('Given 非 PNG 或超出 16MB When 校验 Then 报错', () => {
    expect(isComputerUseScreenshotPng(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe(false)
    expect(() => validateComputerUseVisionImage(new Uint8Array([1]))).toThrow('无效窗口截图')
    expect(isComputerUseVisionImageSizeAllowed(COMPUTER_USE_VISION_MAX_IMAGE_BYTES)).toBe(true)
    expect(isComputerUseVisionImageSizeAllowed(COMPUTER_USE_VISION_MAX_IMAGE_BYTES + 1)).toBe(
      false,
    )
  })

  test('Given OCR 与截图尺寸一致 When 校验 Then 通过', () => {
    expect(
      isComputerUseVisionFrameSizeMatched(
        { width: 800, height: 600 },
        { screenshot_width: 800, screenshot_height: 600 },
      ),
    ).toBe(true)
  })

  test('Given OCR 与截图尺寸不一致 When 校验 Then 报错', () => {
    expect(
      isComputerUseVisionFrameSizeMatched(
        { width: 800, height: 600 },
        { screenshot_width: 1024, screenshot_height: 768 },
      ),
    ).toBe(false)
    expect(() =>
      validateComputerUseVisionFrameSize(
        { width: 800, height: 600 },
        { screenshot_width: 1024, screenshot_height: 768 },
      ),
    ).toThrow('OCR 与 Cua 截图尺寸不一致')
  })

  test('Given OCR 不可用错误 When 归一化 Then 标记本轮不可用', () => {
    expect(describeComputerUseVisionFailure(new ComputerUseVisionUnavailableError())).toEqual({
      message: '本机 Apple Vision 暂不可用或识别超时',
      unavailable: true,
    })
    expect(describeComputerUseVisionFailure(new Error('helper crashed'))).toEqual({
      message: 'helper crashed',
      unavailable: false,
    })
    expect(describeComputerUseVisionFailure('string failure')).toEqual({
      message: 'string failure',
      unavailable: false,
    })
  })
})

describe('Computer Use OCR 入参校验', () => {
  test('Given 合法输入 When 校验 Then 通过', () => {
    expect(() => validateComputerUseVisionInput(baseInput)).not.toThrow()
    expect(() =>
      validateComputerUseVisionInput({
        ...baseInput,
        region: { x: 0, y: 0, width: 1, height: 1 },
        timeoutMs: 0,
        waitForText: 'Ready',
      }),
    ).not.toThrow()
  })

  test('Given pid/windowId 非法 When 校验 Then 报错', () => {
    expect(() => validateComputerUseVisionInput({ ...baseInput, pid: 0 })).toThrow(
      '请使用 list_windows 中的真实 PID 和窗口 ID',
    )
    expect(() => validateComputerUseVisionInput({ ...baseInput, windowId: 1.5 })).toThrow(
      '请使用 list_windows 中的真实 PID 和窗口 ID',
    )
  })

  test('Given session 为空或过长 When 校验 Then 报错', () => {
    expect(() => validateComputerUseVisionInput({ ...baseInput, session: '  ' })).toThrow(
      '需要当前 Cua 操作的 session',
    )
    expect(() =>
      validateComputerUseVisionInput({ ...baseInput, session: 's'.repeat(101) }),
    ).toThrow('需要当前 Cua 操作的 session')
  })

  test('Given region 越界或尺寸非法 When 校验 Then 报错', () => {
    expect(() =>
      validateComputerUseVisionInput({
        ...baseInput,
        region: { x: 0.9, y: 0, width: 0.2, height: 0.5 },
      }),
    ).toThrow('region 必须位于 0–1 的截图范围内')
    expect(() =>
      validateComputerUseVisionInput({
        ...baseInput,
        region: { x: 0, y: 0, width: 0, height: 0.5 },
      }),
    ).toThrow('region 必须位于 0–1 的截图范围内')
  })

  test('Given timeoutMs 越界或非整数 When 校验 Then 报错', () => {
    expect(() => validateComputerUseVisionInput({ ...baseInput, timeoutMs: -1 })).toThrow(
      'timeoutMs 必须在 0–10000 之间',
    )
    expect(() => validateComputerUseVisionInput({ ...baseInput, timeoutMs: 10_001 })).toThrow(
      'timeoutMs 必须在 0–10000 之间',
    )
    expect(() => validateComputerUseVisionInput({ ...baseInput, timeoutMs: 1.5 })).toThrow(
      'timeoutMs 必须在 0–10000 之间',
    )
  })

  test('Given waitForText 为空或过长 When 校验 Then 报错', () => {
    expect(() => validateComputerUseVisionInput({ ...baseInput, waitForText: '   ' })).toThrow(
      'waitForText 需要 1–200 个字符',
    )
    expect(() =>
      validateComputerUseVisionInput({ ...baseInput, waitForText: 'x'.repeat(201) }),
    ).toThrow('waitForText 需要 1–200 个字符')
  })
})

describe('Computer Use OCR 区域过滤与匹配', () => {
  test('Given 低置信度与乱序区域 When 过滤 Then 丢弃低置信度并按 y→x 排序', () => {
    const filtered = filterComputerUseVisionRegions([
      region('low', 5, 5, 0.4),
      region('second', 10, 20),
      region('first', 20, 10),
    ])
    expect(filtered.map((item) => item.text)).toEqual(['first', 'second'])
  })

  test('Given waitForText When 匹配 Then 置信度 ≥0.8 且整行 trim 后完全相等', () => {
    const matches = selectComputerUseVisionMatches(
      [region(' OK ', 0, 0, 0.79), region(' OK ', 10, 0, 0.8), region('OK2', 0, 10)],
      ' OK ',
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]?.bounds.x).toBe(10)
  })

  test('Given 空 waitForText When 匹配 Then 不产生匹配', () => {
    expect(selectComputerUseVisionMatches([region('OK', 0, 0)], '   ')).toEqual([])
  })
})

describe('Computer Use OCR 轮询', () => {
  test('Given 无 waitForText When 读取 Then 只观察一次并返回 ok', async () => {
    let observes = 0
    const dependencies: ComputerUseVisionDependencies = {
      now: () => 0,
      pause: async () => {
        throw new Error('不应暂停')
      },
      observe: async () => {
        observes += 1
        return observation([region('Hello', 0, 0), region('low', 0, 10, 0.2)])
      },
    }
    const result = await readComputerUseText(baseInput, dependencies)
    expect(observes).toBe(1)
    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(1)
    expect(result.regions.map((item) => item.text)).toEqual(['Hello'])
    expect(result.captureId).toBe('cap-1')
    expect(result.coordinateSpace).toBe('screenshot_pixels_top_left')
    expect(result.note).toContain('不证明任务完成')
  })

  test('Given 超过 200 个可见区域 When 读取 Then 截断并标记', async () => {
    const dependencies: ComputerUseVisionDependencies = {
      now: () => 0,
      pause: async () => {},
      observe: async () =>
        observation(Array.from({ length: 201 }, (_, index) => region(`line-${index}`, 0, index))),
    }
    const result = await readComputerUseText(baseInput, dependencies)
    expect(result.regions).toHaveLength(200)
    expect(result.truncated).toBe(true)
  })

  test('Given 第二次观察到文本 When waitForText Then 返回 matched', async () => {
    let now = 0
    let attempts = 0
    const dependencies: ComputerUseVisionDependencies = {
      now: () => now,
      pause: async () => {
        now += 350
      },
      observe: async () => {
        attempts += 1
        return observation(
          attempts === 1 ? [region('Loading', 0, 0)] : [region('Ready', 0, 0)],
        )
      },
    }
    const result = await readComputerUseText(
      { ...baseInput, waitForText: 'Ready' },
      dependencies,
    )
    expect(result.status).toBe('matched')
    expect(result.attempts).toBe(2)
    expect(result.matches).toHaveLength(1)
    expect(result.elapsedMs).toBe(350)
  })

  test('Given 超过等待预算 When waitForText Then 返回 not_found', async () => {
    let now = 0
    let pauses = 0
    const dependencies: ComputerUseVisionDependencies = {
      now: () => now,
      pause: async () => {
        pauses += 1
        now += 350
      },
      observe: async () => {
        now = 600
        return observation([region('Loading', 0, 0)])
      },
    }
    const result = await readComputerUseText(
      { ...baseInput, waitForText: 'Ready', timeoutMs: 500 },
      dependencies,
    )
    expect(result.status).toBe('not_found')
    expect(result.attempts).toBe(1)
    expect(pauses).toBe(0)
  })

  test('Given 文本始终不出现 When waitForText Then 最多尝试 10 次', async () => {
    let pauses = 0
    const dependencies: ComputerUseVisionDependencies = {
      now: () => 0,
      pause: async () => {
        pauses += 1
      },
      observe: async () => observation([region('Loading', 0, 0)]),
    }
    const result = await readComputerUseText(
      { ...baseInput, waitForText: 'Ready', timeoutMs: 10_000 },
      dependencies,
    )
    expect(result.status).toBe('not_found')
    expect(result.attempts).toBe(10)
    expect(pauses).toBe(9)
  })
})

describe('Computer Use OCR 运行时接线', () => {
  function captureDriver(calls: Array<{ tool: string; args: Record<string, unknown> }>) {
    return async (tool: string, args: Record<string, unknown>): Promise<string> => {
      calls.push({ tool, args })
      writeFileSync(String(args.screenshot_out_file), PNG)
      return JSON.stringify({
        screenshot_frame_valid: true,
        capture_id: 'capture-1',
        pid: args.pid,
        window_id: args.window_id,
        screenshot_width: 800,
        screenshot_height: 600,
      })
    }
  }

  test('Given 有效窗口截图 When observe Then 调用 Cua 与 helper 并返回 captureId', async () => {
    const driverCalls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const helperCalls: Array<{ file: string; args: string[] }> = []
    const dependencies = createVisionDependencies(
      '/fake/macos-vision-helper',
      captureDriver(driverCalls),
      async (file, args) => {
        helperCalls.push({ file, args })
        return JSON.stringify({
          width: 800,
          height: 600,
          regions: [region('Ready', 10, 20)],
        })
      },
    )
    const result = await dependencies.observe(baseInput)
    expect(driverCalls[0]?.tool).toBe('get_window_state')
    expect(driverCalls[0]?.args).toMatchObject({
      pid: 1,
      window_id: 2,
      session: 'session-1',
      max_image_dimension: 1600,
    })
    expect(helperCalls[0]?.file).toBe('/fake/macos-vision-helper')
    expect(JSON.parse(helperCalls[0]?.args[0] ?? '{}')).toMatchObject({
      path: driverCalls[0]?.args.screenshot_out_file,
    })
    expect(result.captureId).toBe('capture-1')
    expect(result.regions[0]?.text).toBe('Ready')
  })

  test('Given Cua 未返回可绑定截图 When observe Then 拒绝 OCR', async () => {
    const dependencies = createVisionDependencies(
      '/fake/macos-vision-helper',
      async (_tool, args) => {
        writeFileSync(String(args.screenshot_out_file), PNG)
        return JSON.stringify({ screenshot_frame_valid: false, capture_id: 'x', pid: 1, window_id: 2 })
      },
      async () => JSON.stringify({ width: 1, height: 1, regions: [] }),
    )
    await expect(dependencies.observe(baseInput)).rejects.toThrow('Cua 未返回可绑定操作的有效窗口截图')
  })

  test('Given 非 macOS 或 helper 缺失 When 注册工具 Then 不提供 OCR', () => {
    expect(createComputerUseVisionTools('/missing', { platform: 'win32' })).toHaveLength(0)
    expect(createComputerUseVisionTools('/missing', {
      platform: 'darwin',
      helperExists: () => false,
    })).toHaveLength(0)
  })

  test('Given helper 存在 When 注册工具 Then 工具名与官方一致', () => {
    const tools = createComputerUseVisionTools('/fake/helper', {
      platform: 'darwin',
      helperExists: () => true,
      callDriver: captureDriver([]),
      runHelper: async () => JSON.stringify({ width: 800, height: 600, regions: [] }),
    })
    expect(tools.map((tool) => tool.name)).toEqual(['ComputerUseReadText'])
  })

  test('Given helper 不可用 When 调用工具 Then 本轮禁用 OCR 且第二次直接返回', async () => {
    let driverCalls = 0
    const tool = createComputerUseVisionTools('/fake/helper', {
      platform: 'darwin',
      helperExists: () => true,
      callDriver: async (_tool, args) => {
        driverCalls += 1
        writeFileSync(String(args.screenshot_out_file), PNG)
        return JSON.stringify({
          screenshot_frame_valid: true,
          capture_id: 'capture-1',
          pid: 1,
          window_id: 2,
          screenshot_width: 800,
          screenshot_height: 600,
        })
      },
      runHelper: async () => {
        throw new Error('helper crashed')
      },
    })[0] as unknown as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
    }
    const first = await tool.execute('call-1', baseInput)
    expect(first.isError).toBe(true)
    expect(String(first.content[0]?.text)).toContain('Apple Vision')
    const second = await tool.execute('call-2', baseInput)
    expect(String(second.content[0]?.text)).toContain('本轮不可用')
    expect(driverCalls).toBe(1)
  })
})
