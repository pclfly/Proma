import { afterEach, describe, expect, test } from 'bun:test'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { setMainWindow } from './main-window-store'
import { createMainAgentIpcRegistrar, getMainAgentRenderer } from './agent-renderer-access'

function fixture() {
  let destroyed = false
  const frame = {}
  const target = { mainFrame: frame, isDestroyed: () => destroyed } as WebContents
  const window = { webContents: target, isDestroyed: () => destroyed } as BrowserWindow
  const event = { sender: target, senderFrame: frame } as IpcMainInvokeEvent
  return { window, target, event, destroy: () => { destroyed = true } }
}
afterEach(() => { setMainWindow(null) })

describe('Agent 主窗口 IPC 入口', () => {
  test('Given 已登记主窗口 When 顶层frame调用注册的handler Then 验证后传递原参数', async () => {
    const main = fixture()
    setMainWindow(main.window)
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const register = createMainAgentIpcRegistrar({ handle: (channel, handler) => { handlers.set(channel, handler) } })
    let operations = 0
    register('agent:test', async (_event, value: string) => { operations++; return value })
    expect(await handlers.get('agent:test')!(main.event, '原参数')).toBe('原参数')
    expect(operations).toBe(1)
  })

  test('Given 辅助窗、子frame、缺frame和旧主窗 When 调用注册的handler Then 在任何业务副作用前拒绝', () => {
    const main = fixture()
    const auxiliary = fixture()
    const oldMain = fixture()
    setMainWindow(oldMain.window)
    setMainWindow(main.window)
    let handler!: Parameters<IpcMain['handle']>[1]
    let reservations = 0
    createMainAgentIpcRegistrar({ handle: (_channel, fn) => { handler = fn } })('agent:test', () => { reservations++ })
    for (const event of [auxiliary.event, oldMain.event,
      { ...main.event, senderFrame: {} }, { ...main.event, senderFrame: null }]) {
      expect(() => handler(event as IpcMainInvokeEvent)).toThrow()
    }
    expect(reservations).toBe(0)
  })

  test('Given 主窗口销毁或引用清空 When 获取路由或调用handler Then 不回退到其他窗口', () => {
    const main = fixture()
    setMainWindow(main.window)
    expect(getMainAgentRenderer()).toBe(main.target)
    main.destroy()
    expect(getMainAgentRenderer()).toBeNull()
    setMainWindow(null)
    expect(getMainAgentRenderer()).toBeNull()
  })
})
