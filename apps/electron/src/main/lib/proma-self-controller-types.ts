/**
 * Proma 自操作控制器的公共类型与错误。
 *
 * 拆出本文件是为了让接线方、工具适配层与测试共用同一组契约，同时保持 controller 主体精简。
 */

import type { AxSnapshotElement } from './cdp-ax'
import { PROMA_SELF_CONTROL_ERRORS } from './proma-self-control-policy'
import type { PromaSelfDomAction } from './proma-self-dom-scripts'

export type PromaSelfSendCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>

export interface PromaSelfControllerDeps {
  /** 接线方用主窗口 webContents.debugger.sendCommand 实现；不开放公共调试端口。 */
  sendCommand: PromaSelfSendCommand
  /** 当前用户主会话；ref 与动作队列都只属于这个会话。 */
  sessionId: string
  /** 可注入时钟，默认 Date.now。 */
  now?: () => number
  /** 单条 CDP 命令超时，默认 8000ms。 */
  commandTimeoutMs?: number
  /** waitFor 轮询间隔，默认 250ms。 */
  pollIntervalMs?: number
}

export interface PromaSelfApprovalRequest {
  kind: 'create-project'
  /** 触发项目创建的控件标签，供确认弹窗展示。 */
  label: string
  /** 来自 Observe/Find 的 ref；DomAction 没有 ref 时为 null。 */
  ref: string | null
}

export type PromaSelfApproval = (request: PromaSelfApprovalRequest) => boolean | Promise<boolean>

export interface PromaSelfObservedElement extends AxSnapshotElement {
  /** 标签或角色判定为受保护控件；动作阶段还会用 DOM 标记复检。 */
  protected: boolean
  /** 标签判定为新建/添加项目入口。 */
  projectCreation: boolean
}

export interface PromaSelfObservation {
  sessionId: string
  generation: number
  elements: PromaSelfObservedElement[]
  truncated: boolean
  totalCandidates: number
}

export interface PromaSelfClickResult {
  clicked: true
  ref: string
  label: string
  projectCreation: boolean
  generation: number
}

export interface PromaSelfActResult {
  click: PromaSelfClickResult
  wait: PromaSelfWaitResult | null
}

export interface PromaSelfFillResult {
  filled: true
  ref: string
  length: number
  generation: number
}

export interface PromaSelfPressResult {
  pressed: true
  kind: 'key' | 'text'
  key?: string
  length?: number
  generation: number
}

export interface PromaSelfWaitResult {
  matched: boolean
  kind: 'text' | 'selector'
  value: string
  elapsedMs: number
}

export interface PromaSelfDomActionResult {
  action: PromaSelfDomAction
  selector: string
  result: Record<string, unknown>
}

export interface PromaSelfScrollResult {
  selector: string | null
  result: Record<string, unknown>
}

export interface PromaSelfScreenshotResult {
  mimeType: string
  base64: string
  bytes: number
}

/** 中止由 AbortSignal 触发；已发出的单条 CDP 命令无法撤销，但不会再派发后续动作。 */
export class PromaSelfAbortedError extends Error {
  constructor() {
    super(PROMA_SELF_CONTROL_ERRORS.aborted)
    this.name = 'PromaSelfAbortedError'
  }
}

/** 单条 CDP 命令或等待条件超时。 */
export class PromaSelfTimeoutError extends Error {
  constructor(method: string) {
    super(`${PROMA_SELF_CONTROL_ERRORS.timeout}（${method}）`)
    this.name = 'PromaSelfTimeoutError'
  }
}

export function throwIfPromaSelfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PromaSelfAbortedError()
}
