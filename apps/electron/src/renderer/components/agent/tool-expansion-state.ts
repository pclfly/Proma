/** Bash 命令本身也是详情，不能等到出现非空输出才允许展示。 */
export function canExpandToolDetails(toolName: string, input: Record<string, unknown>, result: string | undefined): boolean {
  return Boolean(result) || (toolName === 'Bash' && typeof input.command === 'string' && input.command.trim().length > 0)
}
