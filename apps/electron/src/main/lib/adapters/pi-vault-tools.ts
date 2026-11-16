/**
 * Pi Vault 展示工具。
 *
 * 只表达「让右侧 Vault 标签展示某篇笔记/文件夹」的意图，不读取、编辑、创建或切换 Vault。
 * 真正的校验、渲染进程回执与超时由 vault-presentation-service 负责。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { VaultPresentationResult } from '@proma/shared'
import { serializePiToolResultPayload } from './pi-tool-result-json'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface VaultToolsContext {
  sessionId: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  productivityTools?: { obsidianEnabled?: boolean }
}

export interface VaultPresentationLike {
  present(
    sessionId: string,
    input: { relativePath?: unknown; kind?: unknown },
    signal?: AbortSignal,
  ): Promise<VaultPresentationResult>
}

function jsonToolResult(payload: unknown) {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text' as const, text: serialized.text }],
    details: serialized.details,
  }
}

export function buildVaultTools(
  sdk: PiSdk,
  ctx: VaultToolsContext,
  presentation: VaultPresentationLike | undefined,
): ToolDefinition[] {
  if (ctx.triggeredBy !== undefined && ctx.triggeredBy !== 'user') return []
  if (ctx.productivityTools?.obsidianEnabled === false) return []
  return [
    sdk.defineTool({
      name: 'VaultOpen',
      label: '展示 Vault',
      description:
        'Present the currently configured Vault in this session’s right-side tab, optionally selecting an existing Markdown file or folder by relative path. '
        + 'Omit both arguments to open the Vault tab. kind defaults to file when relativePath is supplied; use folder with an empty path for the Vault root. '
        + 'This does not read, edit, create, archive, select or switch Vaults. '
        + 'Returns opened only after renderer confirmation; queued means a background session will present it when the user returns, not that it is visible now.',
      promptSnippet:
        'Use VaultOpen when the user should view an existing note/folder or a completed Vault deliverable. '
        + 'Do not auto-archive every turn. Keep original Obsidian Markdown unchanged; presentation is not editing or evidence of user selection.',
      parameters: Type.Object({
        relativePath: Type.Optional(Type.String({ description: 'Path relative to the currently configured Vault; never an absolute root path.' })),
        kind: Type.Optional(Type.Union([Type.Literal('file'), Type.Literal('folder')])),
      }, { additionalProperties: false }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        if (!presentation) {
          return jsonToolResult({ status: 'unavailable', message: 'Vault 展示服务尚未初始化' })
        }
        const input = (params ?? {}) as { relativePath?: unknown; kind?: unknown }
        const result = await presentation.present(ctx.sessionId, input, signal)
        return jsonToolResult(result)
      },
    }),
  ] as unknown as ToolDefinition[]
}
