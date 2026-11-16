import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import { validateToolInput } from '../agent-tool-input-validator'
import { normalizePiPathInput } from './pi-tool-path'
import { displayToolName, normalizePermissionInput, restorePiInput } from './pi-message-adapter'

interface ToolWrapOptions {
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult>
}

/** 在显示别名转换之前验证Pi原始输入，确保错误字段与模型收到的schema一致。 */
export function wrapToolWithPermission<TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  options: ToolWrapOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...definition,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      const rawInput = normalizePiPathInput(definition.name, params as Record<string, unknown>, ctx?.cwd ?? process.cwd())
      const invalid = validateToolInput(definition.name, rawInput)
      if (invalid) throw new Error(invalid.message)
      let updatedParams = rawInput
      if (options.canUseTool) {
        const permission = await options.canUseTool(displayToolName(definition.name, rawInput), normalizePermissionInput(definition.name, rawInput), {
          signal: signal ?? new AbortController().signal,
          toolUseID: toolCallId,
          displayName: definition.label,
          description: definition.description,
        })
        if (permission.behavior === 'deny') throw new Error(permission.message)
        updatedParams = normalizePiPathInput(definition.name, restorePiInput(definition.name, rawInput, permission.updatedInput), ctx?.cwd ?? process.cwd())
        if (updatedParams.path !== rawInput.path) {
          throw new Error('权限输入修改了工具目标路径；本次未执行，请用新工具调用重新检查目录指令和权限。')
        }
        const invalidUpdate = validateToolInput(definition.name, updatedParams)
        if (invalidUpdate) throw new Error(invalidUpdate.message)
      }
      return definition.execute(toolCallId, updatedParams as typeof params, signal, onUpdate as AgentToolUpdateCallback<TDetails> | undefined, ctx) as Promise<AgentToolResult<TDetails>>
    },
  }
}
