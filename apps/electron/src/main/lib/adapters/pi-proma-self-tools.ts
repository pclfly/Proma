/**
 * Proma 自操作 Pi 工具适配层。
 *
 * 官方 0.22.80：Agent 可通过内部调试通道观察和操作 Proma 自身界面。
 * 本文件只做参数校验、触发来源门禁与结果格式转换；真正的 CDP 派发在 PromaSelfController。
 *
 * 边界：
 * - 仅用户主会话可用，automation/delegation/external 触发直接返回空工具列表；
 * - 新建项目点击必须由 requestPromaSelfApproval 取得用户肯定回答；
 * - 受保护控件由控制器拒绝，适配层不提供绕过参数。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { PROMA_SELF_CONTROL_ERRORS } from '../proma-self-control-policy'
import {
  PROMA_SELF_DOM_ACTIONS,
  PROMA_SELF_MAX_SELECTOR_CHARS,
  PROMA_SELF_MAX_TEXT_CHARS,
  PROMA_SELF_MAX_WAIT_VALUE_CHARS,
  type PromaSelfDomAction,
  type PromaSelfDomActionInput,
  type PromaSelfScrollInput,
  type PromaSelfWaitCondition,
} from '../proma-self-dom-scripts'
import type {
  PromaSelfApproval,
  PromaSelfController,
} from '../proma-self-controller'
import { serializePiToolResultPayload } from './pi-tool-result-json'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PromaSelfToolsContext {
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  sessionId: string
  controller: PromaSelfController
  /** 用户在真实界面上对新建项目的肯定回答；自动权限模式不能替代。 */
  requestPromaSelfApproval?: PromaSelfApproval
}

function jsonToolResult(payload: unknown) {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text' as const, text: serialized.text }],
    details: serialized.details,
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredString(value: unknown, label: string, maxLength = 10_000): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串。`)
  if (value.length > maxLength) throw new Error(`${label} 不能超过 ${maxLength} 个字符。`)
  return value
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串。`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new Error(`${label} 不能超过 ${maxLength} 个字符。`)
  return trimmed === '' ? undefined : trimmed
}

function optionalInteger(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数。`)
  }
  return value
}

function readFillText(value: unknown): string {
  if (typeof value !== 'string') throw new Error(PROMA_SELF_CONTROL_ERRORS.textRequired)
  if (value.length > PROMA_SELF_MAX_TEXT_CHARS) throw new Error(PROMA_SELF_CONTROL_ERRORS.textTooLong)
  return value
}

function readWaitCondition(value: unknown): PromaSelfWaitCondition | undefined {
  if (value === undefined || value === null) return undefined
  const record = readRecord(value)
  const kind = record.kind
  if (kind !== 'text' && kind !== 'selector') throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWait)
  const rawValue = record.value
  if (typeof rawValue !== 'string' || rawValue.trim() === '' || rawValue.length > PROMA_SELF_MAX_WAIT_VALUE_CHARS) {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWaitValue)
  }
  return { kind, value: rawValue.trim() }
}

function readDomAction(params: Record<string, unknown>): PromaSelfDomActionInput {
  const action = requiredString(params.action, 'action', 32)
  if (!(PROMA_SELF_DOM_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.domActionUnsupported)
  }
  const selector = requiredString(params.selector, 'selector', PROMA_SELF_MAX_SELECTOR_CHARS)
  const text = params.text
  if (text !== undefined && typeof text !== 'string') throw new Error(PROMA_SELF_CONTROL_ERRORS.textRequired)
  return typeof text === 'string'
    ? { action: action as PromaSelfDomAction, selector, text }
    : { action: action as PromaSelfDomAction, selector }
}

function readScroll(params: Record<string, unknown>): PromaSelfScrollInput {
  const selector = optionalString(params.selector, 'selector', PROMA_SELF_MAX_SELECTOR_CHARS)
  const deltaY = params.deltaY
  const position = params.position
  if (deltaY !== undefined && typeof deltaY !== 'number') throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScrollDelta)
  if (position !== undefined && position !== 'top' && position !== 'bottom') {
    throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScrollPosition)
  }
  if (deltaY !== undefined && position !== undefined) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScroll)
  if (deltaY === undefined && position === undefined) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidScroll)
  return {
    ...(selector ? { selector } : {}),
    ...(typeof deltaY === 'number' ? { deltaY } : {}),
    ...(position === 'top' || position === 'bottom' ? { position } : {}),
  }
}

const REF_DESCRIPTION = 'Element reference from the latest PromaObserve or PromaFind. Refs expire after any new Observe or Find and are bound to this session.'

export function buildPromaSelfTools(sdk: PiSdk, ctx: PromaSelfToolsContext): ToolDefinition[] {
  if (ctx.triggeredBy === 'automation' || ctx.triggeredBy === 'delegation' || ctx.triggeredBy === 'external') return []

  return [
    sdk.defineTool({
      name: 'PromaObserve',
      label: '观察 Proma 界面',
      description:
        'Observe the current Proma main window through the internal accessibility bridge and return bounded elements with refs, roles, names, values and disabled state. '
        + 'Only the user main session may use this. Refs expire after every Observe/Find and are bound to this session. '
        + 'Protected controls (send, approval, AskUser answers, password, delete, payment, authorization) are reported but cannot be operated.',
      promptSnippet: 'Use PromaObserve before acting on Proma UI. Call it again after any panel change, dialog or form state change because old refs become invalid.',
      parameters: Type.Object({
        maxElements: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 400,
          description: 'Maximum number of elements to return. Defaults to 200.',
        })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        const maxElements = optionalInteger(args.maxElements, 'maxElements', 1, 400)
        return jsonToolResult(await ctx.controller.observe(maxElements, signal))
      },
    }),
    sdk.defineTool({
      name: 'PromaFind',
      label: '查找 Proma 界面元素',
      description:
        'Find fresh refs in the Proma main window by accessibility role and/or accessible name without returning the whole observation. '
        + 'Name matching is a case-insensitive substring by default; set exact=true for a full match. '
        + 'A successful Find also expires refs from earlier Observe/Find calls.',
      parameters: Type.Object({
        role: Type.Optional(Type.String({ maxLength: 100, description: 'Accessibility role, for example button, tab, textbox or menuitem.' })),
        name: Type.Optional(Type.String({ maxLength: 500, description: 'Accessible name substring, or the exact name when exact=true.' })),
        exact: Type.Optional(Type.Boolean({ description: 'Require the full accessible name to match.' })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Maximum matches to return. Defaults to 20.' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        const role = optionalString(args.role, 'role', 100)
        const name = optionalString(args.name, 'name', 500)
        if (!role && !name) throw new Error('PromaFind 至少需要 role 或 name。')
        const maxResults = optionalInteger(args.maxResults, 'maxResults', 1, 50)
        return jsonToolResult(await ctx.controller.find({
          ...(role ? { role } : {}),
          ...(name ? { name } : {}),
          exact: args.exact === true,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }, signal))
      },
    }),
    sdk.defineTool({
      name: 'PromaClick',
      label: '点击 Proma 控件',
      description:
        'Click a ref from the latest PromaObserve or PromaFind in the current Proma main window. '
        + 'Protected controls are rejected. Clicking a new-project entry requires a real user approval callback; without a positive answer nothing is dispatched.',
      parameters: Type.Object({
        ref: Type.String({ minLength: 1, maxLength: 200, description: REF_DESCRIPTION }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        return jsonToolResult(await ctx.controller.click(
          requiredString(args.ref, 'ref', 200),
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaAct',
      label: '点击并等待界面',
      description:
        'Click a ref and optionally wait for text or a selector as one serialized Proma operation. '
        + 'Use this when a click should open a panel or dialog and the result must be verified before the next step.',
      parameters: Type.Object({
        ref: Type.String({ minLength: 1, maxLength: 200, description: REF_DESCRIPTION }),
        waitFor: Type.Optional(Type.Object({
          kind: Type.Union([Type.Literal('text'), Type.Literal('selector')]),
          value: Type.String({ minLength: 1, maxLength: PROMA_SELF_MAX_WAIT_VALUE_CHARS }),
        }, { additionalProperties: false })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000, description: 'Wait timeout in milliseconds. Defaults to 10000.' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        return jsonToolResult(await ctx.controller.act(
          requiredString(args.ref, 'ref', 200),
          readWaitCondition(args.waitFor) ?? null,
          optionalInteger(args.timeoutMs, 'timeoutMs', 100, 30_000) ?? 10_000,
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaFill',
      label: '填写 Proma 输入框',
      description:
        'Replace the contents of an editable ref in the Proma main window. '
        + 'Password fields, the Agent message composer and other protected fields are rejected; this never submits a form or sends a message.',
      parameters: Type.Object({
        ref: Type.String({ minLength: 1, maxLength: 200, description: REF_DESCRIPTION }),
        text: Type.String({ maxLength: PROMA_SELF_MAX_TEXT_CHARS, description: 'Replacement text. Empty string clears the field.' }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        return jsonToolResult(await ctx.controller.fill(
          requiredString(args.ref, 'ref', 200),
          readFillText(args.text),
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaPress',
      label: '向 Proma 发送按键',
      description:
        'Press a navigation key (Enter, Tab, Escape, arrows, Backspace, Delete, Home, End, PageUp, PageDown) or type text into the focused element of the Proma main window. '
        + 'Refuses when the focused element is a protected field or control.',
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: PROMA_SELF_MAX_TEXT_CHARS, description: 'Navigation key name or literal text to insert.' }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        return jsonToolResult(await ctx.controller.press(
          requiredString(args.key, 'key', PROMA_SELF_MAX_TEXT_CHARS),
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaDomAction',
      label: '执行 Proma 固定 DOM 操作',
      description:
        'Run one fixed DOM action (focus, fill, click or inspect) against a CSS selector in the Proma main window. '
        + 'Only action names and data are accepted; arbitrary JavaScript is impossible and rejected. '
        + 'Protected elements are rejected and a project-creation click still requires user approval.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('focus'), Type.Literal('fill'), Type.Literal('click'), Type.Literal('inspect')]),
        selector: Type.String({ minLength: 1, maxLength: PROMA_SELF_MAX_SELECTOR_CHARS }),
        text: Type.Optional(Type.String({ maxLength: PROMA_SELF_MAX_TEXT_CHARS, description: 'Required for fill; ignored otherwise.' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        return jsonToolResult(await ctx.controller.domAction(
          readDomAction(readRecord(params)),
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaScroll',
      label: '滚动 Proma 界面',
      description:
        'Scroll the Proma main window or one container by deltaY, or jump to top/bottom. '
        + 'Selector is optional and may traverse open shadow roots; exactly one of deltaY or position is required.',
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ maxLength: PROMA_SELF_MAX_SELECTOR_CHARS })),
        deltaY: Type.Optional(Type.Number({ minimum: -50_000, maximum: 50_000 })),
        position: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('bottom')])),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        return jsonToolResult(await ctx.controller.scroll(
          readScroll(readRecord(params)),
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaWaitFor',
      label: '等待 Proma 界面条件',
      description:
        'Wait until the Proma main window contains the given text or matches a CSS selector, bounded by timeoutMs. '
        + 'Returns matched=false on timeout instead of throwing, so the Agent can re-observe the interface.',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('text'), Type.Literal('selector')]),
        value: Type.String({ minLength: 1, maxLength: PROMA_SELF_MAX_WAIT_VALUE_CHARS }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000, description: 'Defaults to 10000.' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = readRecord(params)
        const condition = readWaitCondition({ kind: args.kind, value: args.value })
        if (!condition) throw new Error(PROMA_SELF_CONTROL_ERRORS.invalidWait)
        return jsonToolResult(await ctx.controller.waitFor(
          condition,
          optionalInteger(args.timeoutMs, 'timeoutMs', 100, 30_000) ?? 10_000,
          signal,
        ))
      },
    }),
    sdk.defineTool({
      name: 'PromaScreenshot',
      label: '截取 Proma 主窗口',
      description:
        'Capture the current Proma main window as a PNG through the internal debug channel. '
        + 'Use PromaObserve first when semantic structure is enough; screenshots are for visual verification only.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, _params, signal?: AbortSignal) {
        const screenshot = await ctx.controller.screenshot(signal)
        return {
          content: [
            { type: 'text' as const, text: `已截取 Proma 主窗口（${screenshot.bytes} 字节）` },
            { type: 'image' as const, data: screenshot.base64, mimeType: screenshot.mimeType },
          ],
          details: { mimeType: screenshot.mimeType, bytes: screenshot.bytes },
        }
      },
    }),
  ]
}
