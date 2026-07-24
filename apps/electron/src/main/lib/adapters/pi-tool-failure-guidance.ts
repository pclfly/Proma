interface ToolResultContent {
  type: string
  text?: string
}

const EDIT_TEXT_NOT_FOUND_PATTERN = /Could not find (?:edits\[\d+\]|the exact text)/i
const MISSING_CLAUDE_MD_PATTERN = /ENOENT[\s\S]*CLAUDE\.md/i

export function buildPiToolFailureGuidance(
  toolName: string,
  isError: boolean,
  content: readonly ToolResultContent[],
): string | undefined {
  if (!isError) return undefined

  const errorText = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n')
  const normalizedToolName = toolName.trim().toLowerCase()

  if (normalizedToolName === 'edit' && EDIT_TEXT_NOT_FOUND_PATTERN.test(errorText)) {
    return '编辑内容与文件当前文本不一致。请重新 Read 目标文件的相关范围，复制最新且唯一的最小 oldText 后重试；不要因为精确匹配失败而用 Write 覆盖整个已有文件。'
  }
  if (normalizedToolName === 'read' && MISSING_CLAUDE_MD_PATTERN.test(errorText)) {
    return '该工作区规则文件当前不存在，跳过即可。不要继续尝试 cwd 下的 CLAUDE.md、大小写变体或枚举目录；仅在用户明确要求创建或确需沉淀长期工作区规则时才创建它。'
  }

  return undefined
}
