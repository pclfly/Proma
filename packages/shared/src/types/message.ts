/**
 * 共享消息、附件与搜索类型
 *
 * 包含消息、对话、流式事件等核心类型，
 * 附件IPC保留历史wire值，已无Chat会话/流式运行协议。
 */

import type { ProviderType } from './channel'


// ===== 附件相关 =====

/** 附件文件大小上限：100MB */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

/** 文件附件 */
export interface FileAttachment {
  /** 附件唯一标识 */
  id: string
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** 相对路径: {conversationId}/{uuid}.ext */
  localPath: string
  /** 文件大小（字节） */
  size: number
}

/** 保存附件输入 */
export interface AttachmentSaveInput {
  /** 对话 ID */
  conversationId: string
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** base64 编码的文件数据 */
  data: string
}

/** 保存附件结果 */
export interface AttachmentSaveResult {
  /** 保存后的附件信息 */
  attachment: FileAttachment
}

/** 文件选择对话框结果 */
export interface FileDialogResult {
  /** 已读取为 base64 的小文件列表 */
  files: FileDialogFile[]
  /** 超过内存导入上限的大文件，仅返回路径，供 Agent 作为附加文件引用 */
  largeFiles?: FileDialogLargeFile[]
  /** 无法读取或无法识别的文件 */
  skippedFiles?: FileDialogSkippedFile[]
}

export interface FileDialogFile {
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface FileDialogLargeFile {
  filename: string
  mediaType: string
  size: number
  path: string
}

export interface FileDialogSkippedFile {
  filename: string
  mediaType?: string
  size?: number
  path?: string
  reason: 'unreadable'
  message?: string
}

/** Agent Composer 混合选择器中返回的目录；目录只授权访问，不作为消息附件复制。 */
export interface FileDialogDirectory {
  name: string
  path: string
}

/** 支持同时选择文件与文件夹的 Agent Composer 选择结果。 */
export interface FileOrFolderDialogResult extends FileDialogResult {
  directories: FileDialogDirectory[]
}

// ===== 消息相关 =====

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 聊天消息
 */
export interface ProviderMessage {
  /** 消息唯一标识 */
  id: string
  /** 发送者角色 */
  role: MessageRole
  /** 消息内容 */
  content: string
  /** 创建时间戳 */
  createdAt: number
  /** 使用的模型 ID（assistant 消息） */
  model?: string
  /** 推理内容（如果模型支持） */
  reasoning?: string
  /** 是否被用户中止 */
  stopped?: boolean
  /** 流式生成时遇到的错误信息 */
  error?: string
  /** 文件附件列表 */
  attachments?: FileAttachment[]
  /** 工具活动记录（assistant 消息，工具调用历史） */
  toolActivities?: ProviderToolActivity[]
}

// ===== 消息搜索 =====

/**
 * 消息搜索结果
 */
export interface SessionMessageSearchResult {
  /** 消息 ID */
  messageId: string
  /** 消息角色 */
  role: MessageRole
  /** 匹配上下文片段，完整保留命中的查询文本 */
  snippet: string
  /** snippet 内匹配起始位置 */
  matchStart: number
  /** 匹配长度 */
  matchLength: number
}

export interface SessionMessageSearchResponse {
  /** 当前查询返回的最佳命中 */
  results: SessionMessageSearchResult[]
  /** 为防止主进程资源耗尽，是否只检索了当前会话的可索引前缀 */
  truncated: boolean
  /** 查询文本过长，已拒绝模糊匹配以保护事件循环 */
  queryTooLong: boolean
}

/**
 * Chat 工具活动（记忆工具调用状态）
 */
export interface ProviderToolActivity {
  /** 工具调用 ID */
  toolCallId: string
  /** 工具名称 */
  toolName: string
  /** 活动类型：开始 / 结果 */
  type: 'start' | 'result'
  /** 执行结果（仅 result 时存在） */
  result?: string
  /** 是否遇到错误 */
  isError?: boolean
  /** 工具调用参数（result 事件中携带，用于语义化短语和结构化结果渲染） */
  input?: Record<string, unknown>
}

// ===== 模型选项 =====

/**
 * 模型选项（扁平化的渠道+模型组合）
 *
 * 用于渲染进程的模型选择器下拉列表
 */
export interface ModelOption {
  /** 渠道 ID */
  channelId: string
  /** 渠道名称 */
  channelName: string
  /** 模型 ID */
  modelId: string
  /** 模型显示名称 */
  modelName: string
  /** AI 供应商类型 */
  provider: ProviderType
}

// ===== IPC 通道常量 =====

/**
 * 通用附件IPC，兼容已落盘的附件和历史wire值
 */
export const ATTACHMENT_IPC_CHANNELS = {
SAVE_ATTACHMENT: 'chat:save-attachment',
READ_ATTACHMENT: 'chat:read-attachment',
SAVE_IMAGE_AS: 'chat:save-image-as',
SAVE_RESOURCE_FILE_AS: 'chat:save-resource-file-as',
DELETE_ATTACHMENT: 'chat:delete-attachment',
OPEN_FILE_DIALOG: 'chat:open-file-dialog',
EXTRACT_ATTACHMENT_TEXT: 'chat:extract-attachment-text'
} as const
