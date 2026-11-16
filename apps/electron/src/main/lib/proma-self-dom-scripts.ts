/**
 * Proma 自操作在渲染进程内执行的固定 DOM 函数。
 *
 * 安全约束：动作与参数以 JSON 数据嵌入，脚本主体由主进程预先生成；
 * Agent 只能选择固定动作（focus/fill/click/inspect）并传入 selector/text，
 * 不能提交任意 JavaScript。所有返回值都是可 JSON 序列化的普通对象。
 */

import {
  PROMA_SELF_CONTROL_ERRORS,
  buildPromaSelfGuardFactorySource,
} from './proma-self-control-policy'

export const PROMA_SELF_DOM_ACTIONS = ['focus', 'fill', 'click', 'inspect'] as const
export type PromaSelfDomAction = (typeof PROMA_SELF_DOM_ACTIONS)[number]

export const PROMA_SELF_MAX_SELECTOR_CHARS = 1_000
export const PROMA_SELF_MAX_TEXT_CHARS = 10_000
export const PROMA_SELF_MAX_WAIT_VALUE_CHARS = 2_000
export const PROMA_SELF_MAX_SCROLL_DELTA = 50_000
export const PROMA_SELF_MAX_PRESS_TEXT_CHARS = 10_000

export interface PromaSelfDomActionInput {
  action: PromaSelfDomAction
  selector: string
  text?: string
}

export interface PromaSelfScrollInput {
  /** 省略时滚动文档；selector 可穿透开放的 shadow root。 */
  selector?: string
  deltaY?: number
  position?: 'top' | 'bottom'
}

export interface PromaSelfWaitCondition {
  kind: 'text' | 'selector'
  value: string
}

export type PromaSelfPressAction =
  | { kind: 'key'; key: string; code: string; windowsVirtualKeyCode: number }
  | { kind: 'text'; text: string }

const NAVIGATION_KEY_CODES: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
}

/** 以 JSON 数据嵌入脚本；U+2028/U+2029 在旧版引擎里会断开字符串字面量。 */
function serializeJsData(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readSelector(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorRequired)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorRequired)
  const selector = value.trim()
  if (required && !selector) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorRequired)
  if (selector.length > PROMA_SELF_MAX_SELECTOR_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorTooLong)
  return selector === '' ? undefined : selector
}

/** 只保留白名单动作与数据字段；额外字段（例如 script）会被丢弃。 */
export function assertPromaSelfDomActionInput(input: PromaSelfDomActionInput): PromaSelfDomActionInput {
  const record = readRecord(input)
  const action = record.action
  if (typeof action !== 'string' || !(PROMA_SELF_DOM_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.domActionUnsupported)
  }
  const selector = readSelector(record.selector, true)
  if (!selector) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorRequired)
  const normalizedAction = action as PromaSelfDomAction
  const rawText = record.text
  if (normalizedAction === 'fill' && typeof rawText !== 'string') {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.textRequired)
  }
  if (rawText !== undefined && typeof rawText !== 'string') {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.textRequired)
  }
  if (typeof rawText === 'string' && rawText.length > PROMA_SELF_MAX_TEXT_CHARS) {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.textTooLong)
  }
  return typeof rawText === 'string'
    ? { action: normalizedAction, selector, text: rawText }
    : { action: normalizedAction, selector }
}

export function assertPromaSelfScrollInput(input: PromaSelfScrollInput): PromaSelfScrollInput {
  const record = readRecord(input)
  const selector = readSelector(record.selector, false)
  const deltaY = record.deltaY
  const position = record.position
  if (deltaY !== undefined && position !== undefined) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScroll)
  if (deltaY === undefined && position === undefined) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScroll)
  if (deltaY !== undefined && (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > PROMA_SELF_MAX_SCROLL_DELTA)) {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScrollDelta)
  }
  if (position !== undefined && position !== 'top' && position !== 'bottom') {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScrollPosition)
  }
  return {
    ...(selector ? { selector } : {}),
    ...(typeof deltaY === 'number' ? { deltaY } : {}),
    ...(position === 'top' || position === 'bottom' ? { position } : {}),
  }
}

export function assertPromaSelfWaitCondition(condition: PromaSelfWaitCondition): PromaSelfWaitCondition {
  const record = readRecord(condition)
  const kind = record.kind
  if (kind !== 'text' && kind !== 'selector') throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWait)
  if (typeof record.value !== 'string' || record.value.trim() === '') throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWaitValue)
  const value = record.value.trim()
  if (value.length > PROMA_SELF_MAX_WAIT_VALUE_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWaitValue)
  if (kind === 'selector' && value.length > PROMA_SELF_MAX_SELECTOR_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorTooLong)
  return { kind, value }
}

/** 导航键保留默认行为；其余文本整体走 Input.insertText。 */
export function parsePromaSelfPressAction(input: string): PromaSelfPressAction {
  if (typeof input !== 'string' || input.length === 0) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidPress)
  const keyCode = NAVIGATION_KEY_CODES[input]
  if (keyCode) return { kind: 'key', key: input, ...keyCode }
  if (input === 'Space') return { kind: 'text', text: ' ' }
  if (input.length > PROMA_SELF_MAX_PRESS_TEXT_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.textTooLong)
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input)) throw new Error('输入文本包含不支持的控制字符。')
  return { kind: 'text', text: input }
}

const FINDER_SNIPPET = `
  const findElement = (root, selector, state) => {
    if (!state || state.visited > 5000) return null;
    state.visited += 1;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const hosts = root.querySelectorAll('*');
    for (const host of hosts) {
      if (!host.shadowRoot) continue;
      const nested = findElement(host.shadowRoot, selector, state);
      if (nested) return nested;
    }
    return null;
  };
`

const SUMMARY_SNIPPET = `
  const summarize = (element) => {
    const rect = element.getBoundingClientRect();
    const isPassword = element instanceof HTMLInputElement && element.type === 'password';
    const rawValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : (element.isContentEditable ? element.textContent || '' : '');
    const style = getComputedStyle(element);
    return {
      tagName: (element.tagName || '').toLowerCase(),
      role: element.getAttribute('role'),
      contentEditable: !!element.isContentEditable,
      focused: document.activeElement === element,
      visible: !!(element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none'),
      valueLength: rawValue.length,
      valuePreview: isPassword ? null : rawValue.slice(0, 300),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  };
`

function guardExpression(): string {
  return `const guard = ${buildPromaSelfGuardFactorySource()};`
}

/** 只读检查：找到元素并返回保护/可编辑状态与摘要，不点击、不输入。 */
export function buildPromaSelfDomInspectExpression(input: { selector: string }): string {
  const selector = readSelector(input.selector, true)
  if (!selector) throw new Error(PROMA_SELF_CONTROL_ERRORS.selectorRequired)
  return `(() => {
    const input = ${serializeJsData({ selector })};
    ${guardExpression()}
    ${FINDER_SNIPPET}
    ${SUMMARY_SNIPPET}
    const element = findElement(document, input.selector, { visited: 0 });
    if (!element) return { ok: false, error: ${serializeJsData(PROMA_SELF_CONTROL_ERRORS.elementMissing)} };
    try { element.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    const description = guard(element);
    return { ok: true, ...description, ...summarize(element) };
  })()`
}

/** 执行固定 DOM 动作；受保护控件在页面内再次拒绝（纵深防御）。 */
export function buildPromaSelfDomActionExpression(input: PromaSelfDomActionInput): string {
  const normalized = assertPromaSelfDomActionInput(input)
  return `(() => {
    const input = ${serializeJsData(normalized)};
    ${guardExpression()}
    ${FINDER_SNIPPET}
    ${SUMMARY_SNIPPET}
    const element = findElement(document, input.selector, { visited: 0 });
    if (!element) return { ok: false, error: ${serializeJsData(PROMA_SELF_CONTROL_ERRORS.elementMissing)} };
    try { element.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    const description = guard(element);
    if (input.action !== 'inspect' && description.protected) {
      return { ok: false, protected: true, error: ${serializeJsData(PROMA_SELF_CONTROL_ERRORS.protectedElement)} };
    }
    if (input.action === 'inspect') return { ok: true, ...description, ...summarize(element) };
    if (input.action === 'focus') {
      element.focus({ preventScroll: true });
      return { ok: true, ...description, ...summarize(element) };
    }
    if (input.action === 'click') {
      if (description.disabled) return { ok: false, disabled: true, error: ${serializeJsData(PROMA_SELF_CONTROL_ERRORS.disabled)} };
      element.click();
      return { ok: true, ...description, ...summarize(element) };
    }
    if (!description.editable) {
      return { ok: false, error: ${serializeJsData(PROMA_SELF_CONTROL_ERRORS.notEditable)} };
    }
    element.focus({ preventScroll: true });
    const text = typeof input.text === 'string' ? input.text : '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
    } else {
      element.textContent = text;
    }
    try {
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, ...description, ...summarize(element) };
  })()`
}

export function buildPromaSelfScrollExpression(input: PromaSelfScrollInput): string {
  const normalized = assertPromaSelfScrollInput(input)
  return `(() => {
    const input = ${serializeJsData(normalized)};
    ${FINDER_SNIPPET}
    const element = input.selector
      ? findElement(document, input.selector, { visited: 0 })
      : (document.scrollingElement || document.documentElement);
    if (!element) return { ok: false, error: '未找到可滚动目标。' };
    if (typeof element.scrollTo !== 'function') return { ok: false, error: '目标不支持滚动。' };
    const read = () => ({ top: Math.round(element.scrollTop), height: Math.round(element.scrollHeight), clientHeight: Math.round(element.clientHeight) });
    const before = read();
    const top = input.position === 'top'
      ? 0
      : input.position === 'bottom'
        ? Math.max(0, element.scrollHeight - element.clientHeight)
        : element.scrollTop + input.deltaY;
    element.scrollTo({ top, left: element.scrollLeft, behavior: 'auto' });
    const after = read();
    return { ok: true, selector: input.selector || null, before, after, moved: before.top !== after.top };
  })()`
}

export function buildPromaSelfWaitExpression(condition: PromaSelfWaitCondition): string {
  const normalized = assertPromaSelfWaitCondition(condition)
  return `(() => {
    const condition = ${serializeJsData(normalized)};
    try {
      if (condition.kind === 'text') return ((document.body && document.body.innerText) || '').includes(condition.value);
      ${FINDER_SNIPPET}
      return !!findElement(document, condition.value, { visited: 0 });
    } catch { return false; }
  })()`
}

/** 读取当前焦点元素的保护状态；Press 前用它拦住密码框和消息输入框。 */
export function buildPromaSelfActiveElementExpression(): string {
  return `(() => {
    ${guardExpression()}
    const element = document.activeElement;
    if (!element) return { protected: false, protectedSelector: null, projectCreation: false, label: '', tagName: '', editable: false, disabled: false };
    return guard(element);
  })()`
}
