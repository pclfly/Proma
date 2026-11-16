import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { ComputerUseAuthorizationError, ComputerUseDriverError } from './computer-use-driver'
import { createComputerUsePreviewTool, createPreviewCapture } from './computer-use-runtime'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const PNG = Buffer.from(PNG_BASE64, 'base64')

describe('Computer Use 预览截图', () => {
  test('Given 窗口目标 When 截取 Then 调用 get_window_state 并返回 data URL', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const capture = createPreviewCapture(async (tool, args) => {
      calls.push({ tool, args })
      writeFileSync(String(args.screenshot_out_file), PNG)
      return '{}'
    })
    const result = await capture({
      id: 'preview-1',
      request: { target: 'window', pid: 123, windowId: 456 },
      signal: new AbortController().signal,
    })
    expect(calls[0]?.tool).toBe('get_window_state')
    expect(calls[0]?.args).toMatchObject({
      session: 'proma-preview-preview-1',
      pid: 123,
      window_id: 456,
      display_only: true,
      include_accessibility_tree: false,
    })
    expect(result.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('Given 桌面目标 When 截取 Then 调用 get_desktop_state 且不带窗口参数', async () => {
    let call: { tool: string; args: Record<string, unknown> } | undefined
    const capture = createPreviewCapture(async (tool, args) => {
      call = { tool, args }
      writeFileSync(String(args.screenshot_out_file), PNG)
      return '{}'
    })
    await capture({
      id: 'preview-2',
      request: { target: 'desktop' },
      signal: new AbortController().signal,
    })
    expect(call?.tool).toBe('get_desktop_state')
    expect(call?.args.pid).toBeUndefined()
    expect(call?.args.window_id).toBeUndefined()
  })

  test('Given driver 未生成有效 PNG When 截取 Then 归一为 capture_failed', async () => {
    const capture = createPreviewCapture(async (_tool, args) => {
      writeFileSync(String(args.screenshot_out_file), 'not a png')
      return '{}'
    })
    await expect(capture({
      id: 'preview-3',
      request: { target: 'window', pid: 1, windowId: 2 },
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ComputerUseDriverError)
  })

  test('Given 未授予自动控制 When 截取 Then 报 authorization_required 而不是模糊的捕图失败', async () => {
    const capture = createPreviewCapture(async () => {
      throw new ComputerUseAuthorizationError('unrequested')
    })
    await expect(capture({
      id: 'preview-auth',
      request: { target: 'desktop' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'authorization_required',
      message: expect.stringContaining('已授权自动控制'),
    })
  })

  test('Given ComputerUsePreview 工具 When finish Then 返回结束文案且不触发截图', async () => {
    const tool = createComputerUsePreviewTool('session-runtime-test') as unknown as {
      name: string
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>
    }
    expect(tool.name).toBe('ComputerUsePreview')
    const result = await tool.execute('call-1', { action: 'finish' }, new AbortController().signal)
    expect(String(result.content[0]?.text)).toContain('预览已结束')
  })
})
