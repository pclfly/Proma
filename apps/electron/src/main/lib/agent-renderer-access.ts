import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { getMainWindow } from './main-window-store'

/** 只使用应用入口登记的主窗口，不按 URL、焦点或枚举顺序猜测窗口角色。 */
export function getMainAgentRenderer(): WebContents | null {
  const target = getMainWindow()?.webContents
  return target && !target.isDestroyed() ? target : null
}

export function isMainAgentRenderer(target: WebContents | null | undefined): target is WebContents {
  return target != null && target === getMainAgentRenderer()
}

export function assertMainAgentRendererTarget(target: WebContents): void {
  if (!isMainAgentRenderer(target)) throw new Error('只有当前主窗口可以操作 Agent 执行与流路由')
}

/** 子 frame 不因共享主 WebContents 就取得执行/流重绑权限。辅助窗使用各自专用 IPC。 */
export function assertMainAgentRendererEvent(event: IpcMainInvokeEvent): WebContents {
  assertMainAgentRendererTarget(event.sender)
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Agent 执行请求必须来自主窗口顶层页面')
  }
  return event.sender
}

/** 执行与流路由 IPC 的共同入口；验证发生在业务 handler 的任何副作用之前。 */
export function createMainAgentIpcRegistrar(ipc: Pick<IpcMain, 'handle'>) {
  return function handleMainAgentIpc<Args extends unknown[], Result>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void {
    ipc.handle(channel, (event, ...args: Args) => {
      assertMainAgentRendererEvent(event)
      return handler(event, ...args)
    })
  }
}
