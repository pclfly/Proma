/**
 * Computer Use 预览状态机与工具执行逻辑。
 *
 * 官方 0.22.0：一个会话同一时间只允许一个预览；窗口预览在 macOS 走
 * native-stream，其余情况走 snapshot；结束 2 秒后清理；原生流只使用
 * 主进程保存的窗口目标。
 *
 * 本地批次把捕获/激活/释放做成注入依赖：状态机、校验与文案是纯逻辑可测；
 * 真正的 desktopCapturer 截图与 Cua `get_window_state` 调用尚未接入。
 */

import { randomUUID } from 'node:crypto'
import type {
  ComputerUsePreviewRequest,
  ComputerUsePreviewState,
  ComputerUsePreviewTarget,
  ComputerUsePreviewTransport,
  ComputerUseWindowTarget,
} from '@proma/shared'
import { ComputerUseDriverError } from './computer-use-driver'

export interface ComputerUsePreviewShowRequest {
  target: ComputerUsePreviewTarget
  label?: string
  pid?: number
  windowId?: number
}

interface PreviewEntry {
  owner: symbol
  request: ComputerUsePreviewShowRequest
  state: ComputerUsePreviewState
  controller: AbortController
  released: boolean
  captureStarted: boolean
  pending?: Promise<void>
  streamValidatedAt?: number
  streamValidation?: Promise<void>
}

export interface ComputerUsePreviewCaptureInput {
  id: string
  request: ComputerUsePreviewShowRequest
  signal: AbortSignal
}

export interface ComputerUsePreviewDependencies {
  platform: string
  now?: () => number
  createId?: () => string
  /** 返回 data:image/png;base64,...；未注入时不截图，只维护状态。 */
  capture?: (input: ComputerUsePreviewCaptureInput) => Promise<string>
  release?: (id: string) => Promise<void>
  /** 把窗口带到前台；需要用户显式触发，未注入时 activate 报“未接入”。 */
  activate?: (request: ComputerUsePreviewShowRequest) => Promise<void>
  validateStreamTarget?: (request: ComputerUsePreviewShowRequest) => Promise<boolean>
}

export function normalizeComputerUsePreviewLabel(
  label: string | undefined,
  target: ComputerUsePreviewTarget,
): string {
  const trimmed = label?.trim().slice(0, 100)
  if (trimmed) return trimmed
  return target === 'desktop' ? '桌面' : '应用窗口'
}

export function resolveComputerUsePreviewTransport(
  platform: string,
  target: ComputerUsePreviewTarget,
): ComputerUsePreviewTransport {
  return platform === 'darwin' && target === 'window' ? 'native-stream' : 'snapshot'
}

export const COMPUTER_USE_PREVIEW_MAX_IMAGE_BYTES = 8 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** 只接受 PNG 魔数；用于 native capture 产出的原始字节。 */
export function isComputerUsePngBytes(image: Uint8Array): boolean {
  return (
    image.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => image[index] === byte)
  )
}

export function isComputerUsePreviewImageSizeAllowed(byteLength: number): boolean {
  return byteLength >= PNG_SIGNATURE.length && byteLength <= COMPUTER_USE_PREVIEW_MAX_IMAGE_BYTES
}

/** 官方预览截图限制：≤8MB 且必须是 PNG。 */
export function validateComputerUsePreviewImage(image: Uint8Array): void {
  if (!isComputerUsePreviewImageSizeAllowed(image.length) || !isComputerUsePngBytes(image)) {
    throw new Error('无效预览图片')
  }
}

/** 注入 capture 返回 data URL 时的形状校验（native 路径应先走字节校验）。 */
export function isComputerUsePreviewDataUrl(value: string): boolean {
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}

/** 校验 show 入参；finish 不需要目标。 */
export function validateComputerUsePreviewRequest(input: ComputerUsePreviewRequest): void {
  if (input.action === 'finish') return
  if (input.target !== 'window' && input.target !== 'desktop') {
    throw new Error('请选择窗口或桌面')
  }
  if (input.target === 'window') {
    if (
      !Number.isSafeInteger(input.pid) ||
      (input.pid ?? 0) <= 0 ||
      !Number.isSafeInteger(input.windowId) ||
      (input.windowId ?? 0) <= 0
    ) {
      throw new Error('窗口预览需要从 list_windows 获取有效的 pid 和 windowId')
    }
  }
}

export class ComputerUsePreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly dependencies: ComputerUsePreviewDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.createId = dependencies.createId ?? (() => randomUUID())
  }

  /** 工具入口：finish 直接结束当前 owner 的预览，show 走状态机。 */
  show(owner: symbol, sessionId: string, input: ComputerUsePreviewRequest): void {
    if (input.action === 'finish') {
      this.finish(owner)
      return
    }
    validateComputerUsePreviewRequest(input)
    const request: ComputerUsePreviewShowRequest = {
      target: input.target as ComputerUsePreviewTarget,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
    }
    this.applyShow(owner, sessionId, request)
  }

  private applyShow(
    owner: symbol,
    sessionId: string,
    request: ComputerUsePreviewShowRequest,
  ): void {
    const current = this.entries.get(sessionId)
    if (current?.state.status === 'running' && current.owner !== owner) {
      throw new Error('当前会话的上一次预览尚未结束')
    }
    const label = normalizeComputerUsePreviewLabel(request.label, request.target)
    const sameWindow =
      request.target === 'desktop' ||
      (current?.request.pid === request.pid && current?.request.windowId === request.windowId)
    if (
      current?.state.status === 'running' &&
      current.owner === owner &&
      current.request.target === request.target &&
      sameWindow
    ) {
      current.request = request
      current.state.label = label
      return
    }
    if (current) this.release(current)
    this.entries.set(sessionId, {
      owner,
      request,
      controller: new AbortController(),
      released: false,
      captureStarted: false,
      state: {
        id: this.createId(),
        sessionId,
        target: request.target,
        label,
        transport: resolveComputerUsePreviewTransport(this.dependencies.platform, request.target),
        status: 'running',
      },
    })
  }

  finish(owner: symbol): void {
    const entry = [...this.entries.values()].find((candidate) => candidate.owner === owner)
    if (!entry || entry.state.status === 'finished') return
    entry.state.finishedAt = this.now()
    entry.state.status = 'finished'
    this.release(entry)
  }

  finishSession(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry) this.finish(entry.owner)
  }

  dismiss(sessionId: string, id: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.id !== id) return
    this.release(entry)
    this.entries.delete(sessionId)
  }

  async activate(sessionId: string, id: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (
      !entry ||
      entry.state.sessionId !== sessionId ||
      entry.state.id !== id ||
      entry.state.status === 'finished' ||
      entry.request.target !== 'window'
    ) {
      throw new Error('预览窗口已失效')
    }
    if (!this.dependencies.activate) throw new Error('桌面预览激活未接入')
    await this.dependencies.activate(entry.request)
  }

  async retry(sessionId: string, id: string): Promise<ComputerUsePreviewState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.id !== id || entry.state.status !== 'error') return null
    this.applyShow(entry.owner, sessionId, entry.request)
    return this.get(sessionId, true)
  }

  /** 原生流只能使用主进程保存的当前目标，不能由 renderer 传入窗口 ID。 */
  getStreamTarget(sessionId: string, id: string): ComputerUseWindowTarget | null {
    const entry = this.entries.get(sessionId)
    if (
      !entry ||
      entry.state.id !== id ||
      entry.state.status !== 'running' ||
      entry.state.transport !== 'native-stream' ||
      entry.request.target !== 'window'
    ) {
      return null
    }
    const { pid, windowId, label } = entry.request
    if (typeof pid !== 'number' || typeof windowId !== 'number') return null
    return { target: 'window', pid, windowId, ...(label ? { label } : {}) }
  }

  watchStreamTarget(sessionId: string, id: string): void {
    const entry = this.entries.get(sessionId)
    if (entry && this.getStreamTarget(sessionId, id)) entry.streamValidatedAt = this.now()
  }

  async fallbackStream(
    sessionId: string,
    id: string,
  ): Promise<ComputerUsePreviewState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry || !this.getStreamTarget(sessionId, id)) return null
    entry.state.transport = 'snapshot'
    return this.get(sessionId, true)
  }

  async get(sessionId: string, capture: boolean): Promise<ComputerUsePreviewState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.sessionId !== sessionId) return null
    if (entry.state.finishedAt !== undefined && this.now() - entry.state.finishedAt > 2_000) {
      this.dismiss(sessionId, entry.state.id)
      return null
    }

    const validateStreamTarget = this.dependencies.validateStreamTarget
    if (
      capture &&
      entry.state.status === 'running' &&
      entry.state.transport === 'native-stream' &&
      entry.streamValidatedAt !== undefined &&
      validateStreamTarget
    ) {
      if (this.now() - entry.streamValidatedAt >= 3_000) {
        entry.streamValidatedAt = this.now()
        entry.streamValidation ??= validateStreamTarget(entry.request)
          .then((available) => {
            if (!available) throw new ComputerUseDriverError('window_unavailable')
          })
          .catch((error: unknown) => {
            if (entry.controller.signal.aborted || entry.state.transport !== 'native-stream') return
            const failure =
              error instanceof ComputerUseDriverError
                ? error
                : new ComputerUseDriverError('capture_failed')
            entry.state.status = 'error'
            entry.state.error = failure.message
            entry.state.errorCode = failure.code
            this.release(entry)
          })
          .finally(() => {
            entry.streamValidation = undefined
          })
      }
      await entry.streamValidation
    }

    const captureFrame = this.dependencies.capture
    if (
      capture &&
      captureFrame &&
      entry.state.status === 'running' &&
      entry.state.transport !== 'native-stream'
    ) {
      entry.captureStarted = true
      entry.pending ??= captureFrame({
        id: entry.state.id,
        request: entry.request,
        signal: entry.controller.signal,
      })
        .then((image) => {
          if (entry.controller.signal.aborted) return
          if (!isComputerUsePreviewDataUrl(image)) {
            throw new ComputerUseDriverError('capture_failed')
          }
          entry.state.image = image
          entry.state.capturedAt = this.now()
        })
        .catch((error: unknown) => {
          if (entry.controller.signal.aborted) return
          entry.state.status = 'error'
          const failure =
            error instanceof ComputerUseDriverError
              ? error
              : new ComputerUseDriverError('capture_failed')
          entry.state.error = failure.message
          entry.state.errorCode = failure.code
          this.release(entry)
        })
        .finally(() => {
          entry.pending = undefined
        })
      await entry.pending
    }

    return this.entries.get(sessionId) === entry ? { ...entry.state } : null
  }

  /**
   * 回收已结束超过 2 秒的预览。
   * 官方用 2 秒定时器；这里改为显式 sweep，避免纯状态机持有计时器。
   */
  sweep(now = this.now()): string[] {
    const removed: string[] = []
    for (const [sessionId, entry] of this.entries) {
      if (entry.state.finishedAt !== undefined && now - entry.state.finishedAt > 2_000) {
        this.release(entry)
        this.entries.delete(sessionId)
        removed.push(sessionId)
      }
    }
    return removed
  }

  private release(entry: PreviewEntry): void {
    if (entry.released) return
    entry.released = true
    entry.controller.abort()
    if (!entry.captureStarted) return
    void Promise.resolve(entry.pending)
      .finally(() => this.dependencies.release?.(entry.state.id))
      .catch(() => {})
  }
}

export const COMPUTER_USE_PREVIEW_TOOL_METADATA = {
  name: 'ComputerUsePreview',
  label: '显示桌面操作预览',
  description:
    '在 Proma 右侧展示当前 Computer Use 目标的窗口镜像。使用 Cua 或 AppleScript 操作、截图本机 App 窗口前，在 Cua list_windows 确认窗口后调用 show；切换目标时再次 show；结束时调用 finish。纯浏览器 DOM/API 读取不需要窗口预览。预览不可用时继续原有任务。只显示画面，不执行点击，不返回截图给模型。桌面预览仅用于用户任务确实需要操作整个桌面的场景。',
  promptSnippet:
    '操作或截图本机 App 窗口（包括 Cua、AppleScript）时用 ComputerUsePreview 展示目标，切换窗口时更新，完成后 finish。',
} as const

export interface ComputerUsePreviewToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
}

/**
 * ComputerUsePreview 工具的文本结果逻辑。
 * 工具注册本身 deferred：需要 Pi 工具运行时与用户授权，当前未接入。
 */
export async function runComputerUsePreviewTool(
  registry: ComputerUsePreviewRegistry,
  owner: symbol,
  sessionId: string,
  request: ComputerUsePreviewRequest,
  signal?: AbortSignal,
): Promise<ComputerUsePreviewToolResult> {
  if (signal?.aborted) throw new Error('操作已取消')
  registry.show(owner, sessionId, request)
  const snapshot = request.action === 'show' ? await registry.get(sessionId, true) : null
  const text =
    request.action === 'finish'
      ? '预览已结束。'
      : snapshot?.error
        ? `${snapshot.error} 可继续原有桌面操作链路，不要为预览重复安装。`
        : !snapshot
          ? '预览已关闭。'
          : '已显示操作预览。Proma 会在此会话可见时刷新画面；预览不代替 Agent 的截图观察。'
  return { content: [{ type: 'text', text }], details: {} }
}
