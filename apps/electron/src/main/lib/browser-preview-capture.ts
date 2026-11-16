/**
 * 受管浏览器标签缩略图。
 *
 * 官方 0.22.0：用户没有直接查看某个 Agent 标签时，renderer 通过 CDP 捕获
 * 一个 640×400 以内的 JPEG 缩略图。同一目标 700ms 内复用缓存；目标切换或
 * 页面代际变化立即取消在途截图。
 */

import type { BrowserPreviewFrame } from '@proma/shared'
import { throwIfBrowserOperationAborted, withBrowserCdpTimeout } from './browser-cdp'

export interface BrowserPreviewTarget {
  tabId: string
  url: string
  generation: number
}

export interface BrowserPreviewDebugger {
  sendCommand: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>
}

export interface BrowserPreviewNativeImage {
  isEmpty: () => boolean
  toJPEG: (quality: number) => Buffer
}

export interface BrowserPreviewCaptureDependencies {
  debugger: BrowserPreviewDebugger
  getTarget: () => BrowserPreviewTarget | null
  encode: (base64: string) => string | null
  /** 未挂载的 WebContentsView 没有 compositor surface，CDP 截图会挂起；用它兜底。 */
  capturePage?: () => Promise<BrowserPreviewNativeImage>
  isVisible?: () => boolean
  timeoutMs?: number
}

interface CachedFrame {
  target: BrowserPreviewTarget
  at: number
  frame: BrowserPreviewFrame
}

interface PendingFrame {
  target: BrowserPreviewTarget
  controller: AbortController
  promise: Promise<BrowserPreviewFrame | null>
}

const CACHE_TTL_MS = 700
const DEFAULT_TIMEOUT_MS = 3_000

function sameTarget(
  left: BrowserPreviewTarget,
  right: BrowserPreviewTarget | null,
): boolean {
  return !!right
    && left.tabId === right.tabId
    && left.url === right.url
    && left.generation === right.generation
}

export class BrowserPreviewCapture {
  private pending: PendingFrame | undefined
  private cache: CachedFrame | undefined

  constructor(private readonly dependencies: BrowserPreviewCaptureDependencies) {}

  invalidate(): void {
    this.pending?.controller.abort()
    this.pending = undefined
    this.cache = undefined
  }

  get(): Promise<BrowserPreviewFrame | null> {
    const target = this.dependencies.getTarget()
    if (!target || !target.url || target.url === 'about:blank') {
      this.invalidate()
      return Promise.resolve(null)
    }
    if (this.pending && !sameTarget(this.pending.target, target)) this.invalidate()
    if (
      this.cache
      && sameTarget(this.cache.target, target)
      && Date.now() - this.cache.at < CACHE_TTL_MS
    ) {
      return Promise.resolve(this.cache.frame)
    }
    if (this.pending) return this.pending.promise

    const controller = new AbortController()
    const pending: PendingFrame = {
      target,
      controller,
      promise: Promise.resolve(null),
    }
    this.pending = pending
    pending.promise = withBrowserCdpTimeout(
      () => this.captureWithFallback(controller.signal),
      'Browser.preview',
      this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      controller.signal,
    ).then((base64) => {
      if (
        !base64
        || this.pending !== pending
        || !sameTarget(target, this.dependencies.getTarget())
      ) {
        return null
      }
      const imageDataUrl = this.dependencies.encode(base64)
      if (!imageDataUrl) return null
      const frame: BrowserPreviewFrame = {
        tabId: target.tabId,
        url: target.url,
        imageDataUrl,
      }
      this.cache = { target, at: Date.now(), frame }
      return frame
    }).catch((error) => {
      console.warn('[浏览器预览] 截图失败:', error)
      return null
    }).finally(() => {
      controller.abort()
      if (this.pending === pending) this.pending = undefined
    })
    return pending.promise
  }

  private async captureWithFallback(signal: AbortSignal): Promise<string | null> {
    const capturePage = this.dependencies.capturePage
    // 隐藏的 WebContentsView 没有可截图的 surface；直接走 Electron 原生截图。
    if (capturePage && this.dependencies.isVisible?.() === false) {
      return this.capturePageBase64(signal)
    }
    try {
      return await this.capture(signal)
    } catch (error) {
      if (!capturePage) throw error
      return this.capturePageBase64(signal)
    }
  }

  private async capturePageBase64(signal: AbortSignal): Promise<string | null> {
    throwIfBrowserOperationAborted(signal)
    const image = await this.dependencies.capturePage?.()
    throwIfBrowserOperationAborted(signal)
    if (!image || image.isEmpty()) return null
    return image.toJPEG(65).toString('base64')
  }

  private async capture(signal: AbortSignal): Promise<string | null> {
    const client = this.dependencies.debugger
    let sessionId: string | undefined
    const detach = (): void => {
      if (!sessionId) return
      const released = sessionId
      sessionId = undefined
      try {
        void client.sendCommand('Target.detachFromTarget', { sessionId: released }).catch(() => undefined)
      } catch {
        // 调试器已失效时忽略。
      }
    }
    signal.addEventListener('abort', detach, { once: true })
    try {
      throwIfBrowserOperationAborted(signal)
      const info = await client.sendCommand('Target.getTargetInfo') as {
        targetInfo?: { targetId?: unknown }
      }
      throwIfBrowserOperationAborted(signal)
      if (typeof info.targetInfo?.targetId !== 'string') return null

      const attached = await client.sendCommand('Target.attachToTarget', {
        targetId: info.targetInfo.targetId,
        flatten: true,
      }) as { sessionId?: unknown }
      if (typeof attached.sessionId !== 'string') return null
      sessionId = attached.sessionId
      throwIfBrowserOperationAborted(signal)

      const readiness = await client.sendCommand('Runtime.evaluate', {
        expression: `(document.readyState === 'interactive' || document.readyState === 'complete')
          && !!document.documentElement && innerWidth > 0 && innerHeight > 0`,
        returnByValue: true,
      }, sessionId) as { result?: { value?: unknown } }
      throwIfBrowserOperationAborted(signal)
      if (readiness.result?.value !== true) return null

      const screenshot = await client.sendCommand('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 65,
        fromSurface: true,
        captureBeyondViewport: false,
      }, sessionId) as { data?: unknown }
      throwIfBrowserOperationAborted(signal)
      return typeof screenshot.data === 'string' ? screenshot.data : null
    } finally {
      signal.removeEventListener('abort', detach)
      detach()
    }
  }
}
