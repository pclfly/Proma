/**
 * Computer Use 原生预览流授权。
 *
 * 官方 0.22.0：renderer 请求预览流时，主进程只为主窗口 mainFrame 发放
 * 10 秒一次性授权；`setDisplayMediaRequestHandler` 消费授权后按 windowId
 * 选择 desktopCapturer source，授权失效或目标切换则返回空。
 *
 * 本地批次实现授权 broker 与发送方校验（纯逻辑可测）；
 * `session.setDisplayMediaRequestHandler` 的 Electron 绑定 deferred。
 */

import type { ComputerUseWindowSource, ComputerUseWindowTarget } from '@proma/shared'
import { findComputerUseWindowSource } from './computer-use-window-source'

export interface ComputerUseStreamSenderEvent {
  sender: unknown
  senderFrame: unknown
}

export interface ComputerUseStreamMainWindow {
  webContents: {
    mainFrame: unknown
  }
}

/**
 * 只有主窗口主 frame 可以请求 CU 预览流。
 * 与官方一致：同时比较 sender 与 senderFrame，防止子 frame / 其他窗口越权。
 */
export function isComputerUseStreamSenderAllowed(
  event: ComputerUseStreamSenderEvent,
  main: ComputerUseStreamMainWindow | null | undefined,
): boolean {
  return (
    Boolean(main) &&
    event.sender === main?.webContents &&
    event.senderFrame === main?.webContents.mainFrame
  )
}

export function assertComputerUseStreamSender(
  event: ComputerUseStreamSenderEvent,
  main: ComputerUseStreamMainWindow | null | undefined,
): void {
  if (!isComputerUseStreamSenderAllowed(event, main)) {
    throw new Error('只有主窗口可以请求 CU 预览流')
  }
}

/** 原生窗口预览仅 macOS 支持，且必须有 senderFrame。 */
export function canPrepareComputerUseStream(
  platform: string,
  hasSenderFrame: boolean,
): boolean {
  return platform === 'darwin' && hasSenderFrame
}

export function assertComputerUseStreamPreconditions(
  platform: string,
  hasSenderFrame: boolean,
): void {
  if (!canPrepareComputerUseStream(platform, hasSenderFrame)) {
    throw new Error('此平台不支持原生窗口预览')
  }
}

interface StreamGrant {
  sessionId: string
  id: string
  windowId: number
  expiresAt: number
}

export interface ComputerUseStreamBrokerDependencies {
  getTarget: (sessionId: string, id: string) => ComputerUseWindowTarget | null
  onGranted?: (sessionId: string, id: string) => void
  getSources: () => Promise<readonly ComputerUseWindowSource[]>
  now?: () => number
}

/**
 * 一次性授权 broker。
 *
 * - prepare：目标必须是当前 native-stream 窗口，写入 10 秒授权；
 * - consume：取出并删除授权，复核授权未过期且目标未变化，再按 windowId 找 source；
 * - 每次 consume 都重新拉取 sources，避免使用过期窗口列表。
 */
export class ComputerUseStreamBroker<TFrame extends object = object> {
  private readonly grants = new WeakMap<TFrame, StreamGrant>()
  private readonly now: () => number

  constructor(private readonly dependencies: ComputerUseStreamBrokerDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
  }

  prepare(frame: TFrame, sessionId: string, id: string): void {
    const target = this.dependencies.getTarget(sessionId, id)
    if (target?.target !== 'window' || !target.windowId) {
      throw new Error('预览窗口已失效')
    }
    this.grants.set(frame, {
      sessionId,
      id,
      windowId: target.windowId,
      expiresAt: this.now() + 10_000,
    })
  }

  async consume(frame: TFrame): Promise<ComputerUseWindowSource | null> {
    const grant = this.grants.get(frame)
    this.grants.delete(frame)
    if (!grant || !this.isCurrent(grant)) return null
    const sources = await this.dependencies.getSources()
    if (!this.isCurrent(grant)) return null
    const source = findComputerUseWindowSource(sources, grant.windowId) ?? null
    if (source) this.dependencies.onGranted?.(grant.sessionId, grant.id)
    return source
  }

  private isCurrent(grant: StreamGrant): boolean {
    const target = this.dependencies.getTarget(grant.sessionId, grant.id)
    return (
      this.now() < grant.expiresAt &&
      target?.target === 'window' &&
      target.windowId === grant.windowId
    )
  }
}

/**
 * Electron `setDisplayMediaRequestHandler` 绑定（deferred）。
 *
 * 官方按 session 只安装一次 handler，并拒绝带音频或非主 frame 的请求。
 * 当前没有 IPC 触发 prepare，因此不启用。
 */
export interface ComputerUseStreamSession {
  setDisplayMediaRequestHandler: (
    handler: (
      request: {
        frame: unknown
        videoRequested: boolean
        audioRequested: boolean
      },
      callback: (streams: { video?: ComputerUseWindowSource }) => void,
    ) => void,
    options: { useSystemPicker: boolean },
  ) => void
}
