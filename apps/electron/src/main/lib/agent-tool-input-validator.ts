/**
 * 工具参数校验模块
 *
 * 在 canUseTool 回调中拦截参数缺失的工具调用，
 * 返回描述性 deny message 引导模型重试。
 */

/** 已知工具的必需参数映射 */
export const TOOL_REQUIRED_PARAMS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['Write', ['file_path', 'content']],
  ['Edit', ['file_path', 'old_string', 'new_string']],
  ['Bash', ['command']],
  ['Read', ['file_path']],
  ['Glob', ['pattern']],
  ['Grep', ['pattern']],
  ['TerminalExecute', ['command']],
  ['TerminalInterrupt', ['terminalId']],
  ['TerminalClose', ['terminalId']],
])

/** 校验失败结果，与 PermissionResult deny 形状一致 */
export interface ToolValidationFailure {
  behavior: 'deny'
  message: string
}

/** Pi原生字符串字段和兼容权限输入共享验证，不把空替换文本误判为缺参。 */
function invalid(tool: string, field: string, requirement: string): ToolValidationFailure {
  return { behavior: 'deny', message: `Tool "${tool}" 参数 "${field}" ${requirement}。请按工具 schema 补齐后重试。` }
}

function stringField(tool: string, field: string, value: unknown, allowEmpty = false): ToolValidationFailure | null {
  if (typeof value !== 'string') return invalid(tool, field, '必须存在且为字符串')
  if (!allowEmpty && value.length === 0) return invalid(tool, field, '不能为空')
  return null
}

export function validateToolInput(toolName: string, input: Record<string, unknown>): ToolValidationFailure | null {
  const name = toolName.toLowerCase()
  if (name === 'edit' || name === 'multiedit') {
    // 原生路径与规范化后的权限输入都保留edits；legacy输入仅用于兼容已有调用。
    const native = name === 'multiedit' || 'edits' in input || toolName === 'edit'
    const pathError = stringField(toolName, native ? 'path' : 'file_path', input.path ?? input.file_path)
    if (pathError) return pathError
    if (native) {
      if (!Array.isArray(input.edits) || input.edits.length === 0) return invalid(toolName, 'edits', '必须是至少包含一项的数组')
      for (const [index, item] of input.edits.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid(toolName, `edits[${index}]`, '必须为替换对象')
        const edit = item as Record<string, unknown>
        const error = stringField(toolName, `edits[${index}].oldText`, edit.oldText)
          ?? stringField(toolName, `edits[${index}].newText`, edit.newText, true)
        if (error) return error
      }
      return null
    }
    return stringField(toolName, 'old_string', input.old_string)
      ?? stringField(toolName, 'new_string', input.new_string, true)
  }
  if (name === 'write') {
    return stringField(toolName, 'path' in input ? 'path' : 'file_path', input.path ?? input.file_path)
      ?? stringField(toolName, 'content', input.content, true)
  }
  if (toolName === 'read') return stringField(toolName, 'path', input.path)
  if (toolName === 'bash' || toolName === 'powershell') return stringField(toolName, 'command', input.command)
  if (toolName === 'find' || toolName === 'grep') return stringField(toolName, 'pattern', input.pattern)
  const requiredParams = TOOL_REQUIRED_PARAMS.get(toolName)
  if (!requiredParams) return null
  for (const param of requiredParams) {
    const error = stringField(toolName, param, input[param])
    if (error) return error
  }
  return null
}
