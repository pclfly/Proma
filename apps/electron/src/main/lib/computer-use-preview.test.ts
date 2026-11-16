import { describe, expect, test } from 'bun:test'
import { ComputerUseDriverError } from './computer-use-driver'
import {
  COMPUTER_USE_PREVIEW_MAX_IMAGE_BYTES,
  ComputerUsePreviewRegistry,
  isComputerUsePngBytes,
  isComputerUsePreviewDataUrl,
  isComputerUsePreviewImageSizeAllowed,
  normalizeComputerUsePreviewLabel,
  resolveComputerUsePreviewTransport,
  runComputerUsePreviewTool,
  validateComputerUsePreviewImage,
  validateComputerUsePreviewRequest,
  type ComputerUsePreviewDependencies,
} from './computer-use-preview'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function createRegistry(overrides: Partial<ComputerUsePreviewDependencies> = {}): {
  registry: ComputerUsePreviewRegistry
  advance: (ms: number) => void
  now: () => number
} {
  let now = 0
  let sequence = 0
  const dependencies: ComputerUsePreviewDependencies = {
    platform: 'win32',
    now: () => now,
    createId: () => `preview-${++sequence}`,
  }
  Object.assign(dependencies, overrides)
  const registry = new ComputerUsePreviewRegistry(dependencies)
  return {
    registry,
    advance: (ms) => {
      now += ms
    },
    now: () => now,
  }
}

describe('Computer Use 预览图像校验', () => {
  test('Given PNG 魔数 When 校验 Then 通过', () => {
    expect(isComputerUsePngBytes(PNG)).toBe(true)
    expect(() => validateComputerUsePreviewImage(PNG)).not.toThrow()
  })

  test('Given 非 PNG 或空字节 When 校验 Then 报错', () => {
    expect(isComputerUsePngBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false)
    expect(() => validateComputerUsePreviewImage(new Uint8Array([0]))).toThrow('无效预览图片')
  })

  test('Given 大小边界 When 校验 Then 只接受 8 字节到 8MB', () => {
    expect(isComputerUsePreviewImageSizeAllowed(8)).toBe(true)
    expect(isComputerUsePreviewImageSizeAllowed(COMPUTER_USE_PREVIEW_MAX_IMAGE_BYTES)).toBe(true)
    expect(isComputerUsePreviewImageSizeAllowed(COMPUTER_USE_PREVIEW_MAX_IMAGE_BYTES + 1)).toBe(
      false,
    )
    expect(isComputerUsePreviewImageSizeAllowed(7)).toBe(false)
  })

  test('Given data URL When 校验 Then 只接受 png base64', () => {
    expect(isComputerUsePreviewDataUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isComputerUsePreviewDataUrl('data:image/jpeg;base64,AAAA')).toBe(false)
    expect(isComputerUsePreviewDataUrl('not-a-data-url')).toBe(false)
  })

  test('Given 注入 capture 返回非法 data URL When get Then capture_failed', async () => {
    const { registry } = createRegistry({ capture: async () => 'not-a-data-url' })
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    const state = await registry.get('session-1', true)
    expect(state?.status).toBe('error')
    expect(state?.errorCode).toBe('capture_failed')
  })
})

describe('Computer Use 预览入参校验', () => {
  test('Given finish When 校验 Then 不需要目标', () => {
    expect(() => validateComputerUsePreviewRequest({ action: 'finish' })).not.toThrow()
  })

  test('Given 未指定目标 When 校验 Then 报错', () => {
    expect(() => validateComputerUsePreviewRequest({ action: 'show' })).toThrow('请选择窗口或桌面')
  })

  test('Given 窗口预览缺少 pid/windowId When 校验 Then 报错', () => {
    expect(() =>
      validateComputerUsePreviewRequest({ action: 'show', target: 'window', pid: 1 }),
    ).toThrow('有效的 pid 和 windowId')
    expect(() =>
      validateComputerUsePreviewRequest({ action: 'show', target: 'window', pid: 0, windowId: 2 }),
    ).toThrow('有效的 pid 和 windowId')
  })

  test('Given 合法窗口/桌面 When 校验 Then 通过', () => {
    expect(() =>
      validateComputerUsePreviewRequest({
        action: 'show',
        target: 'window',
        pid: 100,
        windowId: 200,
      }),
    ).not.toThrow()
    expect(() =>
      validateComputerUsePreviewRequest({ action: 'show', target: 'desktop' }),
    ).not.toThrow()
  })
})

describe('Computer Use 预览标签与传输', () => {
  test('Given 空白标签 When 归一化 Then 使用目标默认文案并截断到 100 字', () => {
    expect(normalizeComputerUsePreviewLabel(undefined, 'desktop')).toBe('桌面')
    expect(normalizeComputerUsePreviewLabel('   ', 'window')).toBe('应用窗口')
    expect(normalizeComputerUsePreviewLabel(` ${'a'.repeat(120)} `, 'window')).toHaveLength(100)
  })

  test('Given macOS 窗口 When 选择传输 Then native-stream', () => {
    expect(resolveComputerUsePreviewTransport('darwin', 'window')).toBe('native-stream')
  })

  test('Given 非 macOS 或桌面 When 选择传输 Then snapshot', () => {
    expect(resolveComputerUsePreviewTransport('win32', 'window')).toBe('snapshot')
    expect(resolveComputerUsePreviewTransport('darwin', 'desktop')).toBe('snapshot')
  })
})

describe('Computer Use 预览状态机', () => {
  test('Given 首次 show desktop When get Then 返回运行中的 snapshot 状态', async () => {
    const { registry } = createRegistry()
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop', label: ' Finder ' })
    const state = await registry.get('session-1', false)
    expect(state).toEqual({
      id: 'preview-1',
      sessionId: 'session-1',
      target: 'desktop',
      label: 'Finder',
      transport: 'snapshot',
      status: 'running',
    })
  })

  test('Given 同一 owner 重复 show 相同目标 When 更新 Then 复用 id 只更新标签', async () => {
    const { registry } = createRegistry()
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop', label: 'A' })
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop', label: 'B' })
    const state = await registry.get('session-1', false)
    expect(state?.id).toBe('preview-1')
    expect(state?.label).toBe('B')
  })

  test('Given 另一 owner 正在预览 When show Then 拒绝抢占', () => {
    const { registry } = createRegistry()
    registry.show(Symbol('first'), 'session-1', { action: 'show', target: 'desktop' })
    expect(() =>
      registry.show(Symbol('second'), 'session-1', { action: 'show', target: 'desktop' }),
    ).toThrow('上一次预览尚未结束')
  })

  test('Given finish When get Then 状态 finished，2 秒后自动清理', async () => {
    const { registry, advance } = createRegistry()
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop' })
    registry.finish(owner)
    expect((await registry.get('session-1', false))?.status).toBe('finished')
    advance(2_001)
    expect(await registry.get('session-1', false)).toBeNull()
  })

  test('Given finishSession When 查询 Then 对应会话结束', async () => {
    const { registry } = createRegistry()
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    registry.finishSession('session-1')
    expect((await registry.get('session-1', false))?.status).toBe('finished')
  })

  test('Given dismiss 使用错误 id When 调用 Then 不删除当前预览', async () => {
    const { registry } = createRegistry()
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    registry.dismiss('session-1', 'preview-999')
    expect(await registry.get('session-1', false)).not.toBeNull()
    registry.dismiss('session-1', 'preview-1')
    expect(await registry.get('session-1', false)).toBeNull()
  })

  test('Given 会话不匹配 When get Then null', async () => {
    const { registry } = createRegistry()
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    expect(await registry.get('session-2', false)).toBeNull()
  })

  test('Given 已结束超过 2 秒 When sweep Then 回收条目', () => {
    const { registry, advance } = createRegistry()
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop' })
    registry.finish(owner)
    advance(2_001)
    expect(registry.sweep()).toEqual(['session-1'])
    expect(registry.sweep()).toEqual([])
  })
})

describe('Computer Use 原生流目标', () => {
  test('Given macOS 窗口预览 When 读取流目标 Then 返回主进程保存的窗口', async () => {
    const { registry } = createRegistry({ platform: 'darwin' })
    registry.show(Symbol('owner'), 'session-1', {
      action: 'show',
      target: 'window',
      pid: 42,
      windowId: 7,
      label: 'Editor',
    })
    const state = await registry.get('session-1', false)
    expect(state?.transport).toBe('native-stream')
    expect(registry.getStreamTarget('session-1', state?.id ?? '')).toEqual({
      target: 'window',
      pid: 42,
      windowId: 7,
      label: 'Editor',
    })
  })

  test('Given snapshot 或已结束 When 读取流目标 Then null', async () => {
    const { registry } = createRegistry({ platform: 'win32' })
    registry.show(Symbol('owner'), 'session-1', {
      action: 'show',
      target: 'window',
      pid: 42,
      windowId: 7,
    })
    expect(registry.getStreamTarget('session-1', 'preview-1')).toBeNull()
  })

  test('Given fallbackStream When 调用 Then 切换为 snapshot 并返回状态', async () => {
    const { registry } = createRegistry({ platform: 'darwin' })
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', {
      action: 'show',
      target: 'window',
      pid: 42,
      windowId: 7,
    })
    const state = await registry.fallbackStream('session-1', 'preview-1')
    expect(state?.transport).toBe('snapshot')
    expect(registry.getStreamTarget('session-1', 'preview-1')).toBeNull()
  })

  test('Given 原生流目标校验失败 When get 触发校验 Then 状态转 error', async () => {
    const { registry, advance } = createRegistry({
      platform: 'darwin',
      validateStreamTarget: async () => false,
    })
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', {
      action: 'show',
      target: 'window',
      pid: 42,
      windowId: 7,
    })
    registry.watchStreamTarget('session-1', 'preview-1')
    advance(3_000)
    const state = await registry.get('session-1', true)
    expect(state?.status).toBe('error')
    expect(state?.errorCode).toBe('window_unavailable')
  })
})

describe('Computer Use 预览捕获注入', () => {
  test('Given 注入 capture When get true Then 写入图片与时间', async () => {
    const { registry } = createRegistry({
      capture: async () => 'data:image/png;base64,AAAA',
    })
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    const state = await registry.get('session-1', true)
    expect(state?.image).toBe('data:image/png;base64,AAAA')
    expect(state?.capturedAt).toBe(0)
  })

  test('Given capture 抛普通错误 When get true Then 归一化为 capture_failed', async () => {
    const { registry } = createRegistry({
      capture: async () => {
        throw new Error('boom')
      },
    })
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    const state = await registry.get('session-1', true)
    expect(state?.status).toBe('error')
    expect(state?.errorCode).toBe('capture_failed')
    expect(state?.error).toContain('未能取得有效窗口画面')
  })

  test('Given capture 抛驱动错误 When get true Then 保留错误码', async () => {
    const { registry } = createRegistry({
      capture: async () => {
        throw new ComputerUseDriverError('window_unavailable')
      },
    })
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    const state = await registry.get('session-1', true)
    expect(state?.errorCode).toBe('window_unavailable')
  })

  test('Given error 状态 When retry Then 重建预览并重新捕获', async () => {
    let captures = 0
    const { registry } = createRegistry({
      capture: async () => {
        captures += 1
        if (captures === 1) throw new Error('boom')
        return 'data:image/png;base64,BBBB'
      },
    })
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    const failed = await registry.get('session-1', true)
    expect(failed?.status).toBe('error')
    const retried = await registry.retry('session-1', 'preview-1')
    expect(retried?.id).toBe('preview-2')
    expect(retried?.status).toBe('running')
    expect(retried?.image).toBe('data:image/png;base64,BBBB')
  })

  test('Given 非 error 状态 When retry Then null', async () => {
    const { registry } = createRegistry()
    registry.show(Symbol('owner'), 'session-1', { action: 'show', target: 'desktop' })
    expect(await registry.retry('session-1', 'preview-1')).toBeNull()
  })
})

describe('Computer Use 预览激活', () => {
  test('Given 未注入 activate When 调用 Then 明确提示未接入', async () => {
    const { registry } = createRegistry()
    registry.show(Symbol('owner'), 'session-1', {
      action: 'show',
      target: 'window',
      pid: 1,
      windowId: 2,
    })
    await expect(registry.activate('session-1', 'preview-1')).rejects.toThrow('未接入')
  })

  test('Given 注入 activate When 调用 Then 传递窗口目标', async () => {
    const activated: Array<{ pid?: number; windowId?: number }> = []
    const { registry } = createRegistry({
      activate: async (request) => {
        activated.push({ pid: request.pid, windowId: request.windowId })
      },
    })
    registry.show(Symbol('owner'), 'session-1', {
      action: 'show',
      target: 'window',
      pid: 11,
      windowId: 22,
    })
    await registry.activate('session-1', 'preview-1')
    expect(activated).toEqual([{ pid: 11, windowId: 22 }])
  })

  test('Given 桌面预览或已结束 When activate Then 预览已失效', async () => {
    const { registry } = createRegistry({ activate: async () => {} })
    const owner = Symbol('owner')
    registry.show(owner, 'session-1', { action: 'show', target: 'desktop' })
    await expect(registry.activate('session-1', 'preview-1')).rejects.toThrow('预览窗口已失效')
    registry.finish(owner)
    await expect(registry.activate('session-1', 'preview-1')).rejects.toThrow('预览窗口已失效')
  })
})

describe('Computer Use 预览工具文案', () => {
  test('Given finish When 执行工具 Then 返回结束文案', async () => {
    const { registry } = createRegistry()
    const result = await runComputerUsePreviewTool(
      registry,
      Symbol('owner'),
      'session-1',
      { action: 'finish' },
    )
    expect(result.content[0]?.text).toBe('预览已结束。')
  })

  test('Given 正常 show When 执行工具 Then 返回已显示文案', async () => {
    const { registry } = createRegistry({
      capture: async () => 'data:image/png;base64,AAAA',
    })
    const result = await runComputerUsePreviewTool(
      registry,
      Symbol('owner'),
      'session-1',
      { action: 'show', target: 'desktop' },
    )
    expect(result.content[0]?.text).toContain('已显示操作预览')
  })

  test('Given 捕获失败 When 执行工具 Then 提示不要重复安装', async () => {
    const { registry } = createRegistry({
      capture: async () => {
        throw new Error('boom')
      },
    })
    const result = await runComputerUsePreviewTool(
      registry,
      Symbol('owner'),
      'session-1',
      { action: 'show', target: 'desktop' },
    )
    expect(result.content[0]?.text).toContain('不要为预览重复安装')
  })

  test('Given 已取消信号 When 执行工具 Then 抛出取消', async () => {
    const { registry } = createRegistry()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runComputerUsePreviewTool(
        registry,
        Symbol('owner'),
        'session-1',
        { action: 'show', target: 'desktop' },
        controller.signal,
      ),
    ).rejects.toThrow('操作已取消')
  })
})
