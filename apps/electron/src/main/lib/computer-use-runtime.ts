/**
 * Computer Use 运行时接线。
 *
 * 把 driver 客户端、预览状态机、窗口源与 Electron 原生预览流串起来：
 * - 预览截图通过 Cua `get_window_state` / `get_desktop_state` 写入临时 PNG；
 * - release/activate 通过 `end_session` / `bring_to_front`；
 * - 原生流只允许主窗口请求，并且只使用主进程保存的窗口目标；
 * - OCR 仍只在 macOS + Apple Vision helper 可用时启用。
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Session, WebContents, WebFrameMain } from 'electron'
import type {
  ComputerUsePreviewRequest,
  ComputerUsePreviewState,
  ComputerUseWindowSource,
} from '@proma/shared'
import {
  ComputerUseAuthorizationError,
  ComputerUseDriverError,
  createComputerUseDriverClient,
  nodeComputerUseDriverInvoke,
} from './computer-use-driver'
import {
  getComputerUseAuthorization,
  resolveConfiguredDriverPath,
} from './computer-use-service'
import {
  ComputerUsePreviewRegistry,
  validateComputerUsePreviewImage,
  type ComputerUsePreviewCaptureInput,
} from './computer-use-preview'
import { ComputerUseStreamBroker } from './computer-use-stream'
import {
  createElectronWindowSourceProvider,
  hasComputerUseWindowSource,
} from './computer-use-window-source'
import { getMainWindow } from './main-window-store'

interface DisplayMediaRequestLike {
  frame?: WebFrameMain
  videoRequested?: boolean
  audioRequested?: boolean
}

interface DisplayMediaSessionLike {
  setDisplayMediaRequestHandler: (
    handler: (request: DisplayMediaRequestLike, callback: (streams: { video?: ComputerUseWindowSource }) => void) => void,
    options: { useSystemPicker: boolean },
  ) => void
}

export async function callComputerUseDriver(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const client = createComputerUseDriverClient({
    resolvePath: resolveConfiguredDriverPath,
    invoke: nodeComputerUseDriverInvoke,
    authorization: getComputerUseAuthorization(),
  })
  return client.call(tool, args, signal)
}

export type ComputerUseDriverCaller = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>

export function createPreviewCapture(
  callDriver: ComputerUseDriverCaller,
): (input: ComputerUsePreviewCaptureInput) => Promise<string> {
  return async (input) => {
    const directory = await mkdtemp(join(tmpdir(), 'proma-preview-'))
    try {
      const path = join(directory, 'frame.png')
      const common = {
        session: `proma-preview-${input.id}`,
        screenshot_out_file: path,
        max_image_dimension: 960,
      }
      await callDriver(
        input.request.target === 'desktop' ? 'get_desktop_state' : 'get_window_state',
        input.request.target === 'desktop'
          ? common
          : {
              ...common,
              pid: input.request.pid,
              window_id: input.request.windowId,
              include_accessibility_tree: false,
              display_only: true,
            },
        input.signal,
      )
      const image = await readFile(path)
      validateComputerUsePreviewImage(image)
      return `data:image/png;base64,${image.toString('base64')}`
    } catch (error) {
      if (error instanceof ComputerUseDriverError) throw error
      // 未授予自动控制时不掩盖真正原因：否则用户只会看到笼统的「未能取得有效窗口画面」。
      if (error instanceof ComputerUseAuthorizationError) {
        throw new ComputerUseDriverError('authorization_required')
      }
      throw new ComputerUseDriverError('capture_failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

const capturePreview = createPreviewCapture(callComputerUseDriver)

const windowSourceProvider = createElectronWindowSourceProvider()

export const computerUsePreview = new ComputerUsePreviewRegistry({
  platform: process.platform,
  capture: capturePreview,
  release: async (id) => {
    await callComputerUseDriver('end_session', { session: `proma-preview-${id}` }).catch(() => {})
  },
  async activate(input) {
    if (input.pid === undefined || input.windowId === undefined) throw new Error('预览窗口已失效')
    const session = `proma-preview-open-${randomUUID()}`
    try {
      await callComputerUseDriver('bring_to_front', {
        pid: input.pid,
        window_id: input.windowId,
        session,
      })
    } finally {
      await callComputerUseDriver('end_session', { session }).catch(() => {})
    }
  },
  validateStreamTarget: async (input) => {
    if (input.windowId === undefined) return false
    return hasComputerUseWindowSource(await windowSourceProvider.getSources(), input.windowId)
  },
})

export const computerUseStreamBroker = new ComputerUseStreamBroker<WebFrameMain>({
  getTarget: (sessionId, id) => computerUsePreview.getStreamTarget(sessionId, id),
  onGranted: (sessionId, id) => computerUsePreview.watchStreamTarget(sessionId, id),
  getSources: () => windowSourceProvider.getSources(),
})

const configuredStreamSessions = new WeakSet<Session>()

export interface ComputerUseStreamEvent {
  sender: WebContents
  senderFrame: WebFrameMain | null
}

export function assertComputerUseStreamSender(event: ComputerUseStreamEvent): void {
  const main = getMainWindow()
  if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) {
    throw new Error('只有主窗口可以请求 CU 预览流')
  }
}

export function prepareComputerUseStream(
  event: ComputerUseStreamEvent,
  sessionId: string,
  id: string,
): void {
  assertComputerUseStreamSender(event)
  if (process.platform !== 'darwin' || !event.senderFrame) {
    throw new Error('此平台不支持原生窗口预览')
  }
  const browserSession = event.sender.session
  if (!configuredStreamSessions.has(browserSession)) {
    configuredStreamSessions.add(browserSession)
    const target = browserSession as unknown as DisplayMediaSessionLike
    target.setDisplayMediaRequestHandler((request, callback) => {
      const main = getMainWindow()
      if (
        !request.frame
        || !main
        || request.frame !== main.webContents.mainFrame
        || !request.videoRequested
        || request.audioRequested
      ) {
        callback({})
        return
      }
      const frame = request.frame
      void computerUseStreamBroker.consume(frame).then((source) => {
        const current = getMainWindow()
        callback(source && current?.webContents.mainFrame === frame ? { video: source } : {})
      }, () => callback({}))
    }, { useSystemPicker: false })
  }
  computerUseStreamBroker.prepare(event.senderFrame, sessionId, id)
}

export function getComputerUsePreview(
  sessionId: string,
  capture: boolean,
): Promise<ComputerUsePreviewState | null> {
  return computerUsePreview.get(sessionId, capture)
}

export function dismissComputerUsePreview(sessionId: string, id: string): void {
  computerUsePreview.dismiss(sessionId, id)
}

export function activateComputerUsePreview(sessionId: string, id: string): Promise<void> {
  return computerUsePreview.activate(sessionId, id)
}

export function retryComputerUsePreview(
  sessionId: string,
  id: string,
): Promise<ComputerUsePreviewState | null> {
  return computerUsePreview.retry(sessionId, id)
}

export function fallbackComputerUseStream(
  sessionId: string,
  id: string,
): Promise<ComputerUsePreviewState | null> {
  return computerUsePreview.fallbackStream(sessionId, id)
}

const previewOwners = new Map<string, symbol>()

function previewOwnerForSession(sessionId: string): symbol {
  let owner = previewOwners.get(sessionId)
  if (!owner) {
    owner = Symbol(`computer-use-preview-${sessionId}`)
    previewOwners.set(sessionId, owner)
  }
  return owner
}

/** Agent 工具：把目标窗口镜像展示在右侧预览面板。 */
export function createComputerUsePreviewTool(sessionId: string): ToolDefinition {
  const owner = previewOwnerForSession(sessionId)
  return {
    name: 'ComputerUsePreview',
    label: '显示桌面操作预览',
    description: '在 Proma 右侧展示当前 Computer Use 目标的窗口镜像。使用 Cua 或 AppleScript 操作、截图本机 App 窗口前，在 Cua list_windows 确认窗口后调用 show；切换目标时再次 show；结束时调用 finish。纯浏览器 DOM/API 读取不需要窗口预览。预览不可用时继续原有任务。只显示画面，不执行点击，不返回截图给模型。桌面预览仅用于用户任务确实需要操作整个桌面的场景。',
    promptSnippet: '操作或截图本机 App 窗口（包括 Cua、AppleScript）时用 ComputerUsePreview 展示目标，切换窗口时更新，完成后 finish。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('show'), Type.Literal('finish')]),
      target: Type.Optional(Type.Union([Type.Literal('window'), Type.Literal('desktop')])),
      label: Type.Optional(Type.String({ description: '展示给用户的应用或窗口名称。' })),
      pid: Type.Optional(Type.Integer({ minimum: 1 })),
      windowId: Type.Optional(Type.Integer({ minimum: 1, description: 'list_windows 返回的 window_id。' })),
    }),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error('操作已取消')
      const input = params as ComputerUsePreviewRequest
      computerUsePreview.show(owner, sessionId, input)
      const snapshot = input.action === 'show' ? await computerUsePreview.get(sessionId, true) : null
      const text = input.action === 'finish'
        ? '预览已结束。'
        : snapshot?.error
          ? `${snapshot.error} 可继续原有桌面操作链路，不要为预览重复安装。`
          : !snapshot
            ? '预览已关闭。'
            : '已显示操作预览。Proma 会在此会话可见时刷新画面；预览不代替 Agent 的截图观察。'
      return { content: [{ type: 'text' as const, text }], details: {} }
    },
  } as ToolDefinition
}
