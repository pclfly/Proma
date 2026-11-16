/**
 * Proma 自操作控制器。
 *
 * 通过接线方注入的 webContents.debugger.sendCommand 观察并操作当前 Proma 主窗口。
 * 安全边界：
 * - 只持有一个主窗口/session 的控制器，不扩展为任意应用控制；
 * - Observe/Find 递增 generation，旧 ref 立即失效；ref 前缀绑定 sessionId，跨会话 ref 必然拒绝；
 * - 所有动作进入同一条串行队列，AbortSignal 在每次派发前检查；
 * - 受保护控件在标签、DOM 标记与页面内保护函数三层拒绝；
 * - 新建项目必须由 approve 回调拿到用户肯定回答，且同一代次只派发一次；
 * - DomAction 只接受固定动作与数据，Agent 无法提交任意 JavaScript。
 */

import { createHash } from 'node:crypto'
import {
  PROMA_SELF_AX_MAX_ELEMENTS,
  PROMA_SELF_AX_MAX_RESULTS,
  buildAxSnapshot,
  findAxNodes,
  resolvePromaSelfAxDepth,
  type AxFindQuery,
  type AxSnapshot,
  type AxSnapshotElement,
  type CdpAxNodeLike,
} from './cdp-ax'
import {
  PROMA_SELF_CONTROL_ERRORS,
  buildPromaSelfGuardProbeSource,
  isPromaSelfControlAxNodeProtected,
  isPromaSelfControlProjectCreationLabel,
  parsePromaSelfGuardDescription,
  type PromaSelfGuardDescription,
} from './proma-self-control-policy'
import {
  PROMA_SELF_MAX_TEXT_CHARS,
  assertPromaSelfDomActionInput,
  assertPromaSelfScrollInput,
  assertPromaSelfWaitCondition,
  buildPromaSelfActiveElementExpression,
  buildPromaSelfDomActionExpression,
  buildPromaSelfDomInspectExpression,
  buildPromaSelfScrollExpression,
  buildPromaSelfWaitExpression,
  parsePromaSelfPressAction,
  type PromaSelfDomActionInput,
  type PromaSelfScrollInput,
  type PromaSelfWaitCondition,
} from './proma-self-dom-scripts'
import {
  PromaSelfAbortedError,
  PromaSelfTimeoutError,
  throwIfPromaSelfAborted,
  type PromaSelfActResult,
  type PromaSelfApproval,
  type PromaSelfClickResult,
  type PromaSelfControllerDeps,
  type PromaSelfDomActionResult,
  type PromaSelfFillResult,
  type PromaSelfObservation,
  type PromaSelfPressResult,
  type PromaSelfScreenshotResult,
  type PromaSelfScrollResult,
  type PromaSelfWaitResult,
} from './proma-self-controller-types'
import {
  PromaSelfCommandRuntime,
  readPromaSelfRecord,
} from './proma-self-controller-runtime'

export {
  PromaSelfAbortedError,
  PromaSelfTimeoutError,
  throwIfPromaSelfAborted,
} from './proma-self-controller-types'
export type {
  PromaSelfActResult,
  PromaSelfApproval,
  PromaSelfApprovalRequest,
  PromaSelfClickResult,
  PromaSelfControllerDeps,
  PromaSelfDomActionResult,
  PromaSelfFillResult,
  PromaSelfObservation,
  PromaSelfObservedElement,
  PromaSelfPressResult,
  PromaSelfScreenshotResult,
  PromaSelfScrollResult,
  PromaSelfSendCommand,
  PromaSelfWaitResult,
} from './proma-self-controller-types'

interface PromaSelfRefEntry {
  sessionId: string
  generation: number
  backendNodeId: number
  role: string
  name: string
  protectedByLabel: boolean
  projectCreationByLabel: boolean
}

function readErrorMessage(record: Record<string, unknown>): string | undefined {
  return typeof record.error === 'string' && record.error ? record.error : undefined
}

/** AskUser 选项使用独立文案，其余受保护控件统一拒绝。 */
function protectedControlMessage(description: PromaSelfGuardDescription): string {
  return description.protectedSelector === '[data-proma-ask-user-option]'
    ? PROMA_SELF_CONTROL_ERRORS.askUserOption
    : PROMA_SELF_CONTROL_ERRORS.protectedElement
}

/** 截断 SHA-256 作为会话令牌：不同会话的 ref 文本不会碰撞。 */
function sessionRefPrefix(sessionId: string): string {
  return `p${createHash('sha256').update(sessionId).digest('base64url').slice(0, 16)}-`
}

export class PromaSelfController {
  private readonly runtime: PromaSelfCommandRuntime
  private readonly sessionId: string
  private readonly refPrefix: string
  private readonly now: () => number
  private refs = new Map<string, PromaSelfRefEntry>()
  private generation = 0
  private projectCreationGeneration: number | null = null

  constructor(deps: PromaSelfControllerDeps) {
    if (!deps || typeof deps.sendCommand !== 'function') {
      throw new Error('Proma 自操作控制器需要 sendCommand 依赖。')
    }
    if (typeof deps.sessionId !== 'string' || deps.sessionId.trim() === '') {
      throw new Error('Proma 自操作控制器需要非空 sessionId。')
    }
    const commandTimeoutMs = typeof deps.commandTimeoutMs === 'number' && deps.commandTimeoutMs > 0 ? deps.commandTimeoutMs : 8_000
    const pollIntervalMs = typeof deps.pollIntervalMs === 'number' && deps.pollIntervalMs > 0 ? deps.pollIntervalMs : 250
    this.runtime = new PromaSelfCommandRuntime({ sendCommand: deps.sendCommand, commandTimeoutMs, pollIntervalMs })
    this.sessionId = deps.sessionId
    this.refPrefix = sessionRefPrefix(deps.sessionId)
    this.now = typeof deps.now === 'function' ? deps.now : Date.now
  }

  /** 观察当前主窗口；新的观察会使全部旧 ref 失效。 */
  async observe(maxElements: number = 200, signal?: AbortSignal): Promise<PromaSelfObservation> {
    return this.runtime.run(signal, async () => {
      const snapshot = await this.readAxSnapshot(maxElements, signal)
      return this.buildObservation(snapshot, snapshot.elements)
    })
  }

  /** 语义查找并返回新 ref；同样递增 generation。 */
  async find(query: AxFindQuery, signal?: AbortSignal): Promise<PromaSelfObservation> {
    const role = typeof query?.role === 'string' ? query.role.trim() : ''
    const name = typeof query?.name === 'string' ? query.name.trim() : ''
    if (!role && !name) throw new Error('语义定位至少需要 role 或 name。')
    if (role.length > 100) throw new Error('role 不能超过 100 个字符。')
    if (name.length > 500) throw new Error('name 不能超过 500 个字符。')
    const maxResults = query?.maxResults
    if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > PROMA_SELF_AX_MAX_RESULTS)) {
      throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidMaxResults)
    }
    return this.runtime.run(signal, async () => {
      const snapshot = await this.readAxSnapshot(PROMA_SELF_AX_MAX_ELEMENTS, signal)
      const matched = findAxNodes(snapshot, {
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        exact: query?.exact === true,
        ...(maxResults !== undefined ? { maxResults } : {}),
      })
      this.refs.clear()
      for (const element of matched) this.storeRef(element, snapshot.generation)
      return this.buildObservation(snapshot, matched)
    })
  }

  async click(ref: string, signal?: AbortSignal, approve?: PromaSelfApproval): Promise<PromaSelfClickResult> {
    return this.runtime.run(signal, () => this.clickInternal(ref, signal, approve))
  }

  /** 点击后按需等待条件；点击与等待作为同一条串行操作执行。 */
  async act(
    ref: string,
    waitFor?: PromaSelfWaitCondition | null,
    timeoutMs: number = 10_000,
    signal?: AbortSignal,
    approve?: PromaSelfApproval,
  ): Promise<PromaSelfActResult> {
    if (waitFor) assertPromaSelfWaitCondition(waitFor)
    this.assertWaitTimeout(timeoutMs)
    return this.runtime.run(signal, async () => {
      const click = await this.clickInternal(ref, signal, approve)
      const wait = waitFor ? await this.waitForInternal(waitFor, timeoutMs, signal) : null
      return { click, wait }
    })
  }

  async fill(ref: string, text: string, signal?: AbortSignal, _approve?: PromaSelfApproval): Promise<PromaSelfFillResult> {
    return this.runtime.run(signal, () => this.fillInternal(ref, text, signal))
  }

  async press(key: string, signal?: AbortSignal, _approve?: PromaSelfApproval): Promise<PromaSelfPressResult> {
    return this.runtime.run(signal, () => this.pressInternal(key, signal))
  }

  async domAction(input: PromaSelfDomActionInput, signal?: AbortSignal, approve?: PromaSelfApproval): Promise<PromaSelfDomActionResult> {
    return this.runtime.run(signal, () => this.domActionInternal(input, signal, approve))
  }

  async scroll(input: PromaSelfScrollInput, signal?: AbortSignal, _approve?: PromaSelfApproval): Promise<PromaSelfScrollResult> {
    return this.runtime.run(signal, () => this.scrollInternal(input, signal))
  }

  async waitFor(condition: PromaSelfWaitCondition, timeoutMs: number = 10_000, signal?: AbortSignal): Promise<PromaSelfWaitResult> {
    assertPromaSelfWaitCondition(condition)
    this.assertWaitTimeout(timeoutMs)
    return this.runtime.run(signal, () => this.waitForInternal(condition, timeoutMs, signal))
  }

  async screenshot(signal?: AbortSignal): Promise<PromaSelfScreenshotResult> {
    return this.runtime.run(signal, () => this.screenshotInternal(signal))
  }

  // ===== 内部实现 =====

  private send(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.runtime.send(method, params, signal)
  }

  private async readAxSnapshot(maxElements: number, signal?: AbortSignal): Promise<AxSnapshot> {
    if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > PROMA_SELF_AX_MAX_ELEMENTS) {
      throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidMaxElements)
    }
    const response = await this.send('Accessibility.getFullAXTree', { depth: resolvePromaSelfAxDepth(maxElements) }, signal)
    const rawNodes: unknown[] = Array.isArray(response.nodes) ? response.nodes : []
    const nodes = rawNodes.filter((node): node is CdpAxNodeLike => !!node && typeof node === 'object')
    this.generation += 1
    this.projectCreationGeneration = null
    const snapshot = buildAxSnapshot(nodes, {
      generation: this.generation,
      maxElements,
      refPrefix: this.refPrefix,
      maxNameLength: 160,
    })
    this.refs.clear()
    for (const element of snapshot.elements) this.storeRef(element, snapshot.generation)
    return snapshot
  }

  private storeRef(element: AxSnapshotElement, generation: number): void {
    this.refs.set(element.ref, {
      sessionId: this.sessionId,
      generation,
      backendNodeId: element.backendNodeId,
      role: element.role,
      name: element.name,
      protectedByLabel: isPromaSelfControlAxNodeProtected(element.role, element.name),
      projectCreationByLabel: isPromaSelfControlProjectCreationLabel(element.name),
    })
  }

  private buildObservation(snapshot: AxSnapshot, elements: readonly AxSnapshotElement[]): PromaSelfObservation {
    return {
      sessionId: this.sessionId,
      generation: snapshot.generation,
      elements: elements.map((element) => {
        const entry = this.refs.get(element.ref)
        return {
          ...element,
          protected: entry?.protectedByLabel ?? isPromaSelfControlAxNodeProtected(element.role, element.name),
          projectCreation: entry?.projectCreationByLabel ?? isPromaSelfControlProjectCreationLabel(element.name),
        }
      }),
      truncated: snapshot.truncated,
      totalCandidates: snapshot.totalCandidates,
    }
  }

  private resolveRef(ref: string): PromaSelfRefEntry {
    if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 200) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidRef)
    const entry = this.refs.get(ref)
    if (!entry) throw new Error(PROMA_SELF_CONTROL_ERRORS.refInvalid)
    if (entry.sessionId !== this.sessionId) throw new Error(PROMA_SELF_CONTROL_ERRORS.refForeignSession)
    if (entry.generation !== this.generation) throw new Error(PROMA_SELF_CONTROL_ERRORS.refInvalid)
    return entry
  }

  /** 用固定保护函数检查目标元素及其祖先容器。 */
  private async describeBackendNode(backendNodeId: number, signal?: AbortSignal): Promise<PromaSelfGuardDescription> {
    const resolved = await this.send('DOM.resolveNode', { backendNodeId }, signal)
    const object = readPromaSelfRecord(resolved.object)
    const objectId = object && typeof object.objectId === 'string' ? object.objectId : ''
    if (!objectId) throw new Error(PROMA_SELF_CONTROL_ERRORS.elementMissing)
    const response = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: buildPromaSelfGuardProbeSource(),
      returnByValue: true,
    }, signal)
    const result = readPromaSelfRecord(response.result)
    return parsePromaSelfGuardDescription(result?.value)
  }

  private async resolveActionableRef(ref: string, signal?: AbortSignal): Promise<{ entry: PromaSelfRefEntry; description: PromaSelfGuardDescription }> {
    const entry = this.resolveRef(ref)
    try {
      const description = await this.describeBackendNode(entry.backendNodeId, signal)
      return { entry, description }
    } catch (error) {
      if (error instanceof PromaSelfAbortedError || error instanceof PromaSelfTimeoutError) throw error
      throw new Error(PROMA_SELF_CONTROL_ERRORS.elementMissing)
    }
  }

  private async clickInternal(ref: string, signal?: AbortSignal, approve?: PromaSelfApproval): Promise<PromaSelfClickResult> {
    throwIfPromaSelfAborted(signal)
    const { entry, description } = await this.resolveActionableRef(ref, signal)
    if (entry.protectedByLabel || description.protected) throw new Error(protectedControlMessage(description))
    if (description.disabled) throw new Error(PROMA_SELF_CONTROL_ERRORS.disabled)
    const projectCreation = entry.projectCreationByLabel || description.projectCreation
    if (projectCreation) {
      await this.ensureProjectCreationApproved(description.label || entry.name, ref, approve)
    }
    await this.dispatchClick(entry.backendNodeId, signal)
    return {
      clicked: true,
      ref,
      label: description.label || entry.name,
      projectCreation,
      generation: this.generation,
    }
  }

  private async ensureProjectCreationApproved(label: string, ref: string | null, approve?: PromaSelfApproval): Promise<void> {
    if (this.projectCreationGeneration === this.generation) {
      throw new Error(PROMA_SELF_CONTROL_ERRORS.projectAlreadyApproved)
    }
    if (!approve) throw new Error(PROMA_SELF_CONTROL_ERRORS.projectApprovalRequired)
    const approved = await approve({ kind: 'create-project', label: label.slice(0, 200), ref })
    if (!approved) throw new Error(PROMA_SELF_CONTROL_ERRORS.projectApprovalRequired)
    // 先消费本代次凭据再派发，避免重复点击导致创建多个项目。
    this.projectCreationGeneration = this.generation
  }

  private async dispatchClick(backendNodeId: number, signal?: AbortSignal): Promise<void> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, signal)
    throwIfPromaSelfAborted(signal)
    const box = await this.send('DOM.getBoxModel', { backendNodeId }, signal)
    throwIfPromaSelfAborted(signal)
    const model = readPromaSelfRecord(box.model)
    const content: unknown[] = model && Array.isArray(model.content) ? model.content : []
    const quad = content.map((value) => typeof value === 'number' ? value : Number.NaN)
    if (quad.length < 8 || !quad.every((value) => Number.isFinite(value))) {
      throw new Error(PROMA_SELF_CONTROL_ERRORS.elementMissing)
    }
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = quad
    const x = (x0 + x1 + x2 + x3) / 4
    const y = (y0 + y1 + y2 + y3) / 4
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, signal)
    // 按下已经发生，必须补发释放，避免取消后窗口保留按下的鼠标状态。
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, signal)
  }

  private async fillInternal(ref: string, text: string, signal?: AbortSignal): Promise<PromaSelfFillResult> {
    if (typeof text !== 'string') throw new Error(PROMA_SELF_CONTROL_ERRORS.textRequired)
    if (text.length > PROMA_SELF_MAX_TEXT_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.textTooLong)
    const { entry, description } = await this.resolveActionableRef(ref, signal)
    if (entry.protectedByLabel || description.protected) throw new Error(protectedControlMessage(description))
    if (!description.editable) throw new Error(PROMA_SELF_CONTROL_ERRORS.notEditable)
    if (description.disabled) throw new Error(PROMA_SELF_CONTROL_ERRORS.disabled)
    await this.send('DOM.focus', { backendNodeId: entry.backendNodeId }, signal)
    throwIfPromaSelfAborted(signal)
    const modifier = process.platform === 'darwin' ? 4 : 2
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modifier }, signal)
    // keyDown 后无条件补发 keyUp，避免取消时 Ctrl/Meta 停留在按下状态。
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: modifier }, signal)
    throwIfPromaSelfAborted(signal)
    await this.send('Input.insertText', { text }, signal)
    return { filled: true, ref, length: text.length, generation: this.generation }
  }

  private async pressInternal(key: string, signal?: AbortSignal): Promise<PromaSelfPressResult> {
    throwIfPromaSelfAborted(signal)
    const action = parsePromaSelfPressAction(key)
    const active = await this.readActiveElement(signal)
    if (active.protected) throw new Error(protectedControlMessage(active))
    if (action.kind === 'key') {
      const event = { key: action.key, code: action.code, windowsVirtualKeyCode: action.windowsVirtualKeyCode }
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event }, signal)
      // rawKeyDown 后无条件补发 keyUp，保证按键序列完整。
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, signal)
      return { pressed: true, kind: 'key', key: action.key, generation: this.generation }
    }
    await this.send('Input.insertText', { text: action.text }, signal)
    return { pressed: true, kind: 'text', length: action.text.length, generation: this.generation }
  }

  private async readActiveElement(signal?: AbortSignal): Promise<PromaSelfGuardDescription> {
    const value = await this.evaluateDomValue(buildPromaSelfActiveElementExpression(), signal)
    return parsePromaSelfGuardDescription(value)
  }

  private async evaluateDomValue(expression: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, signal)
    if (response.exceptionDetails) throw new Error(PROMA_SELF_CONTROL_ERRORS.domExecutionFailed)
    const result = readPromaSelfRecord(response.result)
    return result?.value
  }

  private async evaluateDomObject(expression: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return readPromaSelfRecord(await this.evaluateDomValue(expression, signal)) ?? {}
  }

  private async domActionInternal(
    input: PromaSelfDomActionInput,
    signal?: AbortSignal,
    approve?: PromaSelfApproval,
  ): Promise<PromaSelfDomActionResult> {
    const normalized = assertPromaSelfDomActionInput(input)
    if (normalized.action !== 'inspect') {
      const inspection = await this.evaluateDomObject(buildPromaSelfDomInspectExpression({ selector: normalized.selector }), signal)
      if (inspection.ok !== true) {
        throw new Error(readErrorMessage(inspection) ?? PROMA_SELF_CONTROL_ERRORS.elementMissing)
      }
      const description = parsePromaSelfGuardDescription(inspection)
      if (description.protected) throw new Error(protectedControlMessage(description))
      if (normalized.action === 'click' && description.projectCreation) {
        await this.ensureProjectCreationApproved(description.label, null, approve)
      }
      if (description.disabled && (normalized.action === 'click' || normalized.action === 'fill')) {
        throw new Error(PROMA_SELF_CONTROL_ERRORS.disabled)
      }
      if (normalized.action === 'fill' && !description.editable) {
        throw new Error(PROMA_SELF_CONTROL_ERRORS.notEditable)
      }
    }
    const result = await this.evaluateDomObject(buildPromaSelfDomActionExpression(normalized), signal)
    if (result.ok !== true) {
      throw new Error(readErrorMessage(result) ?? PROMA_SELF_CONTROL_ERRORS.domExecutionFailed)
    }
    return { action: normalized.action, selector: normalized.selector, result }
  }

  private async scrollInternal(input: PromaSelfScrollInput, signal?: AbortSignal): Promise<PromaSelfScrollResult> {
    const normalized = assertPromaSelfScrollInput(input)
    const result = await this.evaluateDomObject(buildPromaSelfScrollExpression(normalized), signal)
    if (result.ok !== true) throw new Error(readErrorMessage(result) ?? '滚动失败，请重新观察界面。')
    return { selector: normalized.selector ?? null, result }
  }

  private assertWaitTimeout(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidTimeout)
    }
  }

  private async waitForInternal(condition: PromaSelfWaitCondition, timeoutMs: number, signal?: AbortSignal): Promise<PromaSelfWaitResult> {
    const normalized = assertPromaSelfWaitCondition(condition)
    this.assertWaitTimeout(timeoutMs)
    const startedAt = this.now()
    const pollInterval = Math.max(1, Math.min(this.runtime.pollIntervalMs, timeoutMs))
    // 即使注入的时钟冻结，也必须在有限次数后返回，不能挂死会话队列。
    const maxIterations = Math.max(1, Math.ceil(timeoutMs / pollInterval) + 2)
    let matched = false
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      throwIfPromaSelfAborted(signal)
      const value = await this.evaluateDomValue(buildPromaSelfWaitExpression(normalized), signal)
      if (value === true) {
        matched = true
        break
      }
      const elapsed = Math.max(0, this.now() - startedAt)
      if (elapsed >= timeoutMs) break
      await this.runtime.sleep(Math.min(pollInterval, timeoutMs - elapsed), signal)
    }
    return {
      matched,
      kind: normalized.kind,
      value: normalized.value,
      elapsedMs: Math.max(0, this.now() - startedAt),
    }
  }

  private async screenshotInternal(signal?: AbortSignal): Promise<PromaSelfScreenshotResult> {
    const response = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    }, signal)
    const data = typeof response.data === 'string' ? response.data.trim() : ''
    if (!data) throw new Error(PROMA_SELF_CONTROL_ERRORS.screenshotEmpty)
    if (data.length > 12_000_000) throw new Error(PROMA_SELF_CONTROL_ERRORS.screenshotTooLarge)
    return { mimeType: 'image/png', base64: data, bytes: Math.floor(data.length * 3 / 4) }
  }
}

export function createPromaSelfController(deps: PromaSelfControllerDeps): PromaSelfController {
  return new PromaSelfController(deps)
}
