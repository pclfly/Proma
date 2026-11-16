/**
 * 从写工具输入解析目标路径。
 *
 * 只覆盖结构化文件工具（Write/Edit/MultiEdit/NotebookEdit/Update）；Bash 的
 * 重定向目标由既有 AgentFileChangeTracker 负责，这里不重复解析命令文本。
 */

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update'])

export function resolveToolTargets(toolName: string, input: Record<string, unknown>): string[] {
  if (!MUTATING_TOOLS.has(toolName)) return []
  const candidate = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
  if (typeof candidate !== 'string') return []
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.includes('\n')) return []
  return [trimmed]
}
