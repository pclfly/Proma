/** 仅 main 与受管工具之间的提交凭据。不能由 SDK tool_result 文本补造。 */
export interface KnowledgeFileWitness {
  state: 'missing' | 'text' | 'unsupported'
  physicalPath: string
  sha256?: string
  byteLength?: number
  /** 原始文件 dev/ino/size/mtime/ctime 的稳定版本，不归一化换行。 */
  version?: string
}

export interface KnowledgeMutationBegin {
  toolCallId: string
  toolName: 'write' | 'edit'
  path: string
}

export interface KnowledgeMutationTicket {
  ticketId: string
  candidate: boolean
}

export interface KnowledgeMutationFinish {
  ticketId: string
  toolCallId: string
  outcome: 'success' | 'failed' | 'aborted'
  writeCount: number
  sdkRead?: KnowledgeFileWitness
  preWrite?: KnowledgeFileWitness
  expectedAfterSha256?: string
  expectedAfterBytes?: number
  observedAfter?: KnowledgeFileWitness
}

export interface KnowledgeMutationWitnessRequest {
  ticketId: string
  toolCallId: string
  path: string
}

export interface KnowledgeMutationObserver {
  begin(request: KnowledgeMutationBegin, signal?: AbortSignal): Promise<KnowledgeMutationTicket | null>
  finish(request: KnowledgeMutationFinish, signal?: AbortSignal): Promise<void>
  /** 跨utility也由main验证票据/授权后读取；只回传有界见证，不传正文或解析后的路径凭据。 */
  readWitness?: (request: KnowledgeMutationWitnessRequest, signal?: AbortSignal) => Promise<KnowledgeFileWitness | undefined>
  /** 进程内兼容：已授权文件链接的见证必须读真实目标。 */
  resolveWitnessPath?: (path: string) => string | undefined
}
