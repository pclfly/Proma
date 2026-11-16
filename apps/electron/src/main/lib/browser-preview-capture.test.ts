import { describe, expect, test } from 'bun:test'
import { BrowserPreviewCapture, type BrowserPreviewTarget } from './browser-preview-capture'

function createHarness(initialTarget: BrowserPreviewTarget | null) {
  let target = initialTarget
  const commands: string[] = []
  const debuggerClient = {
    async sendCommand(method: string): Promise<unknown> {
      commands.push(method)
      switch (method) {
        case 'Target.getTargetInfo':
          return { targetInfo: { targetId: 'target-1' } }
        case 'Target.attachToTarget':
          return { sessionId: 'session-1' }
        case 'Runtime.evaluate':
          return { result: { value: true } }
        case 'Page.captureScreenshot':
          return { data: 'base64-jpeg' }
        default:
          return {}
      }
    },
  }
  const capture = new BrowserPreviewCapture({
    debugger: debuggerClient,
    getTarget: () => target,
    encode: (base64) => (base64 ? `data:image/jpeg;base64,${base64}` : null),
  })
  return {
    capture,
    commands,
    setTarget(next: BrowserPreviewTarget | null) {
      target = next
    },
  }
}

const target: BrowserPreviewTarget = {
  tabId: 'tab-1',
  url: 'https://example.com/',
  generation: 1,
}

describe('浏览器标签缩略图', () => {
  test('Given about:blank When 获取 Then 不调用 CDP', async () => {
    const harness = createHarness({ ...target, url: 'about:blank' })
    await expect(harness.capture.get()).resolves.toBeNull()
    expect(harness.commands).toEqual([])
  })

  test('Given 可捕获页面 When 获取 Then attach、检查就绪并截图', async () => {
    const harness = createHarness(target)
    const frame = await harness.capture.get()
    expect(frame).toEqual({
      tabId: 'tab-1',
      url: 'https://example.com/',
      imageDataUrl: 'data:image/jpeg;base64,base64-jpeg',
    })
    expect(harness.commands).toEqual([
      'Target.getTargetInfo',
      'Target.attachToTarget',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Target.detachFromTarget',
    ])
  })

  test('Given 700ms 内重复获取 When 目标未变 Then 复用缓存', async () => {
    const harness = createHarness(target)
    const first = await harness.capture.get()
    const second = await harness.capture.get()
    expect(second).toEqual(first)
    expect(harness.commands.filter((command) => command === 'Page.captureScreenshot')).toHaveLength(1)
  })

  test('Given 页面代际变化 When 获取 Then 重新截图', async () => {
    const harness = createHarness(target)
    await harness.capture.get()
    harness.setTarget({ ...target, generation: 2 })
    await harness.capture.get()
    expect(harness.commands.filter((command) => command === 'Page.captureScreenshot')).toHaveLength(2)
  })

  test('Given 标签未挂载 When 获取 Then 直接使用原生 capturePage 兜底', async () => {
    let debuggerCalls = 0
    const capture = new BrowserPreviewCapture({
      debugger: {
        async sendCommand(): Promise<unknown> {
          debuggerCalls += 1
          return {}
        },
      },
      getTarget: () => target,
      encode: (base64) => `data:image/jpeg;base64,${base64}`,
      isVisible: () => false,
      capturePage: async () => ({
        isEmpty: () => false,
        toJPEG: () => Buffer.from('native-jpeg'),
      }),
    })
    const frame = await capture.get()
    expect(frame?.imageDataUrl).toBe('data:image/jpeg;base64,bmF0aXZlLWpwZWc=')
    expect(debuggerCalls).toBe(0)
  })

  test('Given 可见标签 CDP 截图失败 When 获取 Then 回退原生截图', async () => {
    const capture = new BrowserPreviewCapture({
      debugger: {
        async sendCommand(): Promise<unknown> {
          throw new Error('capture failed')
        },
      },
      getTarget: () => target,
      encode: (base64) => `data:image/jpeg;base64,${base64}`,
      isVisible: () => true,
      capturePage: async () => ({
        isEmpty: () => false,
        toJPEG: () => Buffer.from('fallback-jpeg'),
      }),
    })
    const frame = await capture.get()
    expect(frame?.imageDataUrl).toBe('data:image/jpeg;base64,ZmFsbGJhY2stanBlZw==')
  })

  test('Given 页面未就绪 When 获取 Then 返回 null 且仍 detach', async () => {
    let targetId = 'target-1'
    const commands: string[] = []
    const capture = new BrowserPreviewCapture({
      debugger: {
        async sendCommand(method: string): Promise<unknown> {
          commands.push(method)
          if (method === 'Target.getTargetInfo') return { targetInfo: { targetId } }
          if (method === 'Target.attachToTarget') return { sessionId: 'session-1' }
          if (method === 'Runtime.evaluate') return { result: { value: false } }
          return {}
        },
      },
      getTarget: () => target,
      encode: () => 'data:image/jpeg;base64,x',
    })
    await expect(capture.get()).resolves.toBeNull()
    expect(commands).toContain('Target.detachFromTarget')
    targetId = 'target-2'
  })
})
