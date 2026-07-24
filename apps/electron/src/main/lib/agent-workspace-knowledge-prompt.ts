export interface WorkspaceKnowledgeFileState {
  label: string
  path: string
  exists: boolean
}

export function formatWorkspaceKnowledgeFileState(file: WorkspaceKnowledgeFileState): string {
  if (file.exists) {
    return `${file.label}: ${file.path}（当前存在；需要时只读取此绝对路径）`
  }
  return `${file.label}: ${file.path}（当前不存在；不要调用 Read 探测，也不要从 cwd 猜测同名文件）`
}

export function buildWorkspaceKnowledgeRecoveryInstruction(files: WorkspaceKnowledgeFileState[]): string {
  const existingFiles = files.filter((file) => file.exists)
  const missingFiles = files.filter((file) => !file.exists)
  const instructions = [
    '按需检查会话级和工作区级两个 `.context/` 目录（note.md、todo.md）以及相关 Skills，不要无差别全量读取。',
  ]

  if (existingFiles.length > 0) {
    instructions.push(`仅在与当前任务相关时读取这些已存在文件的绝对路径：${existingFiles.map((file) => file.path).join('、')}。`)
  }
  if (missingFiles.length > 0) {
    instructions.push(`这些文件当前不存在，跳过即可，不要尝试相对路径或大小写变体：${missingFiles.map((file) => file.path).join('、')}。`)
  }

  return instructions.join(' ')
}
