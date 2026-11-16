/**
 * Proma 自操作运行时接线：只绑定当前主窗口的内部 CDP。
 *
 * - 不开放远程调试端口，仅使用 webContents.debugger 的内部通道；
 * - controller 按会话/窗口代际创建，窗口销毁或会话切换后旧 ref 自动失效；
 * - 新建项目必须走真实的系统确认对话框，不把自动权限模式当作同意。
 */

import { dialog, type WebContents } from 'electron'
import { getMainWindow } from './main-window-store'
import { createPromaSelfController, type PromaSelfController } from './proma-self-controller'
import type { PromaSelfApprovalRequest } from './proma-self-controller-types'

interface ActiveController {
  sessionId: string
  webContentsId: number
  controller: PromaSelfController
}

let active: ActiveController | null = null

function ensureAttached(contents: WebContents): boolean {
  if (contents.debugger.isAttached()) return true
  try {
    contents.debugger.attach('1.3')
    void contents.debugger.sendCommand('Accessibility.enable').catch(() => {})
    void contents.debugger.sendCommand('DOM.enable').catch(() => {})
    return true
  } catch (error) {
    console.warn('[Proma 自操作] 无法附加主窗口调试通道:', error)
    return false
  }
}

/** 取当前主窗口的 controller；不可用时返回 undefined，工具层据此不注入。 */
export function getPromaSelfController(sessionId: string): PromaSelfController | undefined {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return undefined
  const contents = window.webContents
  if (contents.isDestroyed()) return undefined
  if (!ensureAttached(contents)) return undefined

  if (active && active.sessionId === sessionId && active.webContentsId === contents.id) {
    return active.controller
  }

  active = {
    sessionId,
    webContentsId: contents.id,
    controller: createPromaSelfController({
      sessionId,
      sendCommand: (method, params) => contents.debugger.sendCommand(method, params),
    }),
  }
  return active.controller
}

/** 新建项目等高风险动作必须由用户当面确认。 */
export async function requestPromaSelfApproval(request: PromaSelfApprovalRequest): Promise<boolean> {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return false
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['允许', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Proma 需要你确认',
    message: '允许 Agent 在 Proma 界面中执行这次操作？',
    detail: request.label,
  })
  return result.response === 0
}

export function disposePromaSelfController(): void {
  const window = getMainWindow()
  const contents = window?.webContents
  if (active && contents && !contents.isDestroyed() && contents.debugger.isAttached()) {
    try {
      contents.debugger.detach()
    } catch {
      // 窗口已销毁时 detach 会抛错，忽略即可。
    }
  }
  active = null
}
