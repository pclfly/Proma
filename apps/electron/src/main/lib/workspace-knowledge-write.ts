import { mkdirSync } from 'node:fs'
import { writeKnowledgeFileAtomic } from './knowledge-file-write'
import { assertKnowledgeResolutionUnchanged, resolveWorkspaceKnowledgePath, type KnowledgeAccessPolicy, type KnowledgePathResolution } from './workspace-knowledge-access'

interface WorkspaceKnowledgeWriteInput {
  getPolicy: () => KnowledgeAccessPolicy
  relativePath: string
  content: string
  expectedContent?: string
  maxBytes: number
  /** 读票据的物理目标/授权/内容复验；在每次原子提交前执行。 */
  validateRevisionTarget?: () => void
}

/** 调用者每次读最新权限；目标在受权根中写入，但原逻辑链接链仍须在提交前不变。 */
export function writeWorkspaceKnowledgeFileAtomic(input: WorkspaceKnowledgeWriteInput): KnowledgePathResolution {
  const initial = resolveWorkspaceKnowledgePath(input.getPolicy(), input.relativePath, { allowMissing: true })
  if (initial.kind === 'directory') throw new Error('知识文件目标不是文件')
  // 唯一可缺失的根是受限 memory/。外置 grant 在 resolver 中必须已经是普通目录。
  mkdirSync(initial.allowedRoot, { recursive: true })
  const validateAccess = (): void => {
    try { assertKnowledgeResolutionUnchanged(initial, resolveWorkspaceKnowledgePath(input.getPolicy(), input.relativePath, { allowMissing: true })) } catch (cause) {
      throw new Error('知识文件路径已变化或授权已撤销，请刷新后重试', { cause })
    }
    input.validateRevisionTarget?.()
  }
  validateAccess()
  writeKnowledgeFileAtomic({ allowedRoot: initial.allowedRoot, filePath: initial.physicalPath, content: input.content, expectedContent: input.expectedContent, maxBytes: input.maxBytes, validateAccess })
  // 返回提交目标，供调用方为同一编辑周期签发后继票据时比较物理目标与授权边界。
  return initial
}
