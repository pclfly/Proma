/**
 * 清单快速捕获窗口。
 *
 * 官方 0.22.0：Cmd/Ctrl+Shift+T 在任意应用下唤起，输入标题后直接落到清单。
 * 无边框 + 透明 + 置顶，失焦自动隐藏；与 Agent 的快速任务窗口相互独立。
 */

import { BrowserWindow, app, screen } from 'electron'
import { join } from 'path'

let quickCaptureTodoWindow: BrowserWindow | null = null

const WINDOW_WIDTH = 560
const WINDOW_HEIGHT = 300

/** 预创建捕获窗口（隐藏状态），避免首次唤起时的创建延迟。 */
export function createQuickCaptureTodoWindow(): void {
  if (quickCaptureTodoWindow && !quickCaptureTodoWindow.isDestroyed()) return

  quickCaptureTodoWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const isDev = !app.isPackaged
  if (isDev) {
    void quickCaptureTodoWindow.loadURL('http://127.0.0.1:5173?window=quick-capture-todo')
  } else {
    void quickCaptureTodoWindow.loadFile(join(__dirname, 'renderer', 'index.html'), {
      query: { window: 'quick-capture-todo' },
    })
  }

  quickCaptureTodoWindow.on('blur', () => {
    if (quickCaptureTodoWindow && !quickCaptureTodoWindow.isDestroyed()) {
      quickCaptureTodoWindow.hide()
    }
  })

  quickCaptureTodoWindow.on('closed', () => {
    quickCaptureTodoWindow = null
  })

  console.log('[清单捕获窗口] 预创建完成')
}

/** 切换捕获窗口显示/隐藏，并通知渲染层聚焦输入框。 */
export function toggleQuickCaptureTodoWindow(): void {
  if (!quickCaptureTodoWindow || quickCaptureTodoWindow.isDestroyed()) {
    createQuickCaptureTodoWindow()
    quickCaptureTodoWindow?.once('ready-to-show', () => {
      positionAndShow()
    })
    return
  }

  if (quickCaptureTodoWindow.isVisible()) {
    quickCaptureTodoWindow.hide()
    return
  }
  positionAndShow()
}

export function hideQuickCaptureTodoWindow(): void {
  if (!quickCaptureTodoWindow || quickCaptureTodoWindow.isDestroyed()) return
  quickCaptureTodoWindow.hide()
}

export function destroyQuickCaptureTodoWindow(): void {
  if (!quickCaptureTodoWindow || quickCaptureTodoWindow.isDestroyed()) {
    quickCaptureTodoWindow = null
    return
  }
  quickCaptureTodoWindow.destroy()
  quickCaptureTodoWindow = null
}

function positionAndShow(): void {
  if (!quickCaptureTodoWindow || quickCaptureTodoWindow.isDestroyed()) return

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const { x, y, width, height } = display.workArea

  quickCaptureTodoWindow.setBounds({
    x: Math.round(x + (width - WINDOW_WIDTH) / 2),
    y: Math.round(y + height * 0.22),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  })

  quickCaptureTodoWindow.show()
  quickCaptureTodoWindow.focus()
  quickCaptureTodoWindow.webContents.send('quick-capture-todo:focus')
}
