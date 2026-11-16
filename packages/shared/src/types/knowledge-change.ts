/** 来源来自受控工具提交，不来自 fs.watch、时间窗口或聊天历史推断。 */
export type WorkspaceKnowledgeFileRef =
  | { kind: 'memory'; relativePath: string }
  | { kind: 'workspace_agents' }
  | { kind: 'project_agents' }

export interface KnowledgeChangeDiff {
  context: string[]
  removed: string[]
  added: string[]
  truncated: boolean
}

export interface AttributedKnowledgeChange {
  changeId: string
  workspaceId: string
  workspaceSlug: string
  file: WorkspaceKnowledgeFileRef
  source: {
    sessionId: string
    runGeneration: number
    queryId: string
    toolCallId: string
    toolName: 'write' | 'edit'
  }
  changedAt: number
  kind: 'created' | 'modified'
  diff: KnowledgeChangeDiff
}

/**
 * 记忆/项目规则工具执行后由本地变更追踪器产出的视图。
 * 与 workspace knowledge 的受控提交凭据不同：这里仅用于展示一次工具调用导致的文件变化。
 */
export interface TrackedKnowledgeChange {
  absolutePath: string
  relativePath: string
  kind: 'created' | 'modified' | 'deleted'
  changedAt: number
  diffAvailable: boolean
  preview?: string
  diff?: KnowledgeChangeDiff
}
