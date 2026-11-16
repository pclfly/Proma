import { describe, expect, test } from 'bun:test'
import type { ComputerUseWindowTarget } from '@proma/shared'
import {
  ComputerUseStreamBroker,
  assertComputerUseStreamPreconditions,
  assertComputerUseStreamSender,
  canPrepareComputerUseStream,
  isComputerUseStreamSenderAllowed,
} from './computer-use-stream'

const sources = [
  { id: 'screen:0:0', name: 'Screen' },
  { id: 'window:77:0', name: 'Editor' },
  { id: 'window:88:0', name: 'Browser' },
]

describe('Computer Use 预览流发送方校验', () => {
  test('Given 主窗口主 frame When 校验 Then 允许', () => {
    const frame = { id: 1 }
    const main = { webContents: { mainFrame: frame } }
    expect(
      isComputerUseStreamSenderAllowed({ sender: main.webContents, senderFrame: frame }, main),
    ).toBe(true)
  })

  test('Given 其他窗口或子 frame When 校验 Then 拒绝', () => {
    const frame = { id: 1 }
    const main = { webContents: { mainFrame: frame } }
    expect(
      isComputerUseStreamSenderAllowed({ sender: {}, senderFrame: frame }, main),
    ).toBe(false)
    expect(
      isComputerUseStreamSenderAllowed({ sender: main.webContents, senderFrame: {} }, main),
    ).toBe(false)
    expect(isComputerUseStreamSenderAllowed({ sender: {}, senderFrame: {} }, null)).toBe(false)
  })

  test('Given 非主窗口 When assert Then 抛出明确错误', () => {
    expect(() =>
      assertComputerUseStreamSender({ sender: {}, senderFrame: {} }, null),
    ).toThrow('只有主窗口可以请求 CU 预览流')
  })

  test('Given 非 macOS 或缺少 frame When 检查 Then 不支持原生流', () => {
    expect(canPrepareComputerUseStream('darwin', true)).toBe(true)
    expect(canPrepareComputerUseStream('win32', true)).toBe(false)
    expect(canPrepareComputerUseStream('darwin', false)).toBe(false)
    expect(() => assertComputerUseStreamPreconditions('win32', true)).toThrow(
      '此平台不支持原生窗口预览',
    )
  })
})

describe('Computer Use 预览流一次性授权', () => {
  function createBroker(initialTarget: ComputerUseWindowTarget | null, nowValue: { value: number }) {
    let target = initialTarget
    const granted: string[] = []
    const broker = new ComputerUseStreamBroker({
      getTarget: () => target,
      onGranted: (sessionId, id) => granted.push(`${sessionId}:${id}`),
      getSources: async () => sources,
      now: () => nowValue.value,
    })
    return {
      broker,
      granted,
      setTarget: (next: ComputerUseWindowTarget | null) => {
        target = next
      },
    }
  }

  test('Given native-stream 窗口 When prepare + consume Then 返回对应 source 并回调 onGranted', async () => {
    const clock = { value: 0 }
    const { broker, granted } = createBroker({ target: 'window', pid: 1, windowId: 77 }, clock)
    const frame = {}
    broker.prepare(frame, 'session-1', 'preview-1')
    const source = await broker.consume(frame)
    expect(source?.id).toBe('window:77:0')
    expect(granted).toEqual(['session-1:preview-1'])
  })

  test('Given 同一 frame 第二次 consume When 调用 Then 授权已消费', async () => {
    const clock = { value: 0 }
    const { broker } = createBroker({ target: 'window', pid: 1, windowId: 77 }, clock)
    const frame = {}
    broker.prepare(frame, 'session-1', 'preview-1')
    await broker.consume(frame)
    expect(await broker.consume(frame)).toBeNull()
  })

  test('Given 超过 10 秒 When consume Then 授权过期', async () => {
    const clock = { value: 0 }
    const { broker, granted } = createBroker({ target: 'window', pid: 1, windowId: 77 }, clock)
    const frame = {}
    broker.prepare(frame, 'session-1', 'preview-1')
    clock.value = 10_001
    expect(await broker.consume(frame)).toBeNull()
    expect(granted).toEqual([])
  })

  test('Given 目标窗口切换 When consume Then 拒绝旧授权', async () => {
    const clock = { value: 0 }
    const { broker, granted, setTarget } = createBroker(
      { target: 'window', pid: 1, windowId: 77 },
      clock,
    )
    const frame = {}
    broker.prepare(frame, 'session-1', 'preview-1')
    setTarget({ target: 'window', pid: 1, windowId: 88 })
    expect(await broker.consume(frame)).toBeNull()
    expect(granted).toEqual([])
  })

  test('Given 目标不再可用 When prepare Then 预览窗口已失效', () => {
    const clock = { value: 0 }
    const { broker } = createBroker(null, clock)
    expect(() => broker.prepare({}, 'session-1', 'preview-1')).toThrow('预览窗口已失效')
  })

  test('Given 拉取 sources 期间目标失效 When consume Then 返回 null 且不回调', async () => {
    const clock = { value: 0 }
    let target: ComputerUseWindowTarget | null = { target: 'window', pid: 1, windowId: 77 }
    const granted: string[] = []
    const broker = new ComputerUseStreamBroker({
      getTarget: () => target,
      onGranted: (sessionId, id) => granted.push(`${sessionId}:${id}`),
      getSources: async () => {
        target = null
        return sources
      },
      now: () => clock.value,
    })
    const frame = {}
    broker.prepare(frame, 'session-1', 'preview-1')
    expect(await broker.consume(frame)).toBeNull()
    expect(granted).toEqual([])
  })
})
