export interface VaultConfig {
  rootPath: string
  displayName: string
  inboxPath: string
  allowAgentWrites: boolean
  configuredAt: number
}

/** Renderer-safe summary. The selected root path stays in the main process. */
export interface VaultSummary {
  /** Stable opaque identity for scoping renderer-local state to this Vault. */
  vaultId: string
  displayName: string
  inboxPath: string
  allowAgentWrites: boolean
  configuredAt: number
}

export interface VaultCandidate {
  path: string
  displayName: string
  isObsidianVault: boolean
  isPromaManaged?: boolean
}

export interface VaultFileEntry {
  kind: 'file'
  relativePath: string
  name: string
  size: number
  modifiedAt: number
}

/** A visible non-hidden directory within the authorized Vault root. */
export interface VaultFolderEntry {
  kind: 'folder'
  relativePath: string
  name: string
}

/** Entries used to build the Vault sidebar tree. */
export type VaultTreeEntry = VaultFileEntry | VaultFolderEntry

/** 单层目录请求：绑定授权库身份，使用分页避免大目录静默截断。 */
export interface VaultDirectoryRequest {
  expectedVaultId: string
  offset?: number
}

/** 单层目录列表；truncated 为真时必须使用 nextOffset 请求同一层的下一页。 */
export interface VaultDirectoryListing {
  relativePath: string
  entries: VaultTreeEntry[]
  truncated: boolean
  nextOffset?: number
}

/** 双链解析请求；target/sourcePath 均为 Vault 内相对路径。 */
export interface VaultWikiLinkRequest {
  vaultId: string
  target: string
  sourcePath: string
  /** 强制丢弃缓存并重建后台索引。 */
  refresh?: boolean
}

export type VaultWikiLinkResult =
  | { status: 'found'; relativePath: string }
  | { status: 'missing' }
  | { status: 'indexing'; message: string }
  | { status: 'ambiguous'; message: string }
  | { status: 'error'; message: string }

/** A user-selected location in a Vault. Paths are always relative to its authorized root. */
export interface VaultFocus {
  kind: 'file' | 'folder'
  relativePath: string
  /** Monotonic per-renderer sequence; the main process ignores stale focus IPC. */
  sequence: number
}

/** Durable turn metadata used to render the post-response Obsidian context chip. */
export interface VaultFocusAttribution {
  displayName: string
  rootPath: string
  focus: VaultFocus
}

/** Agent 请求展示的 Vault 目标；relativePath 始终相对当前 Vault 根。 */
export interface VaultPresentationTarget {
  kind: 'file' | 'folder'
  relativePath: string
}

/** 主进程发给渲染进程的展示请求；与 Vault 身份绑定，切换后作废。 */
export interface VaultPresentationRequest {
  requestId: string
  sessionId: string
  vaultId: string
  configuredAt: number
  target?: VaultPresentationTarget
}

/**
 * 展示结果。
 * - opened：渲染进程已确认打开
 * - queued：后台会话，用户返回时才展示，当前不可见
 * - blocked：目标非法或 Vault 已切换
 * - unavailable：Vault 未配置、窗口不可用或请求超时/取消
 */
export interface VaultPresentationResult {
  requestId: string
  status: 'opened' | 'queued' | 'blocked' | 'unavailable'
  message?: string
}

export interface VaultRenameInput {
  relativePath: string
  name: string
  expectedSha256?: string
}

export interface VaultDeleteInput {
  relativePath: string
  expectedSha256?: string
}

export interface VaultSavePastedImageInput {
  noteRelativePath: string
  mimeType: string
  base64: string
}

export interface VaultReadResult {
  relativePath: string
  content: string
  sha256: string
  modifiedAt: number
}

export interface VaultWriteInput {
  relativePath: string
  content: string
  expectedSha256?: string
  createOnly?: boolean
}

export type VaultWriteResult =
  | { ok: true; relativePath: string; sha256: string; modifiedAt: number }
  | { ok: false; reason: 'conflict'; currentSha256: string; currentModifiedAt: number }

export const VAULT_IPC_CHANNELS = {
  GET_CONFIG: 'vault:get-config',
  SELECT_DEFAULT: 'vault:select-default',
  LIST_CANDIDATES: 'vault:list-candidates',
  SELECT: 'vault:select',
  AUTHORIZE_CANDIDATE: 'vault:authorize-candidate',
  LIST_FILES: 'vault:list-files',
  LIST_DIRECTORY: 'vault:list-directory',
  /** 解析 [[双链]] 到 Vault 内唯一 Markdown 路径 */
  RESOLVE_WIKI_LINK: 'vault:resolve-wiki-link',
  READ_FILE: 'vault:read-file',
  RESOLVE_MEDIA: 'vault:resolve-media',
  SAVE_PASTED_IMAGE: 'vault:save-pasted-image',
  WRITE_FILE: 'vault:write-file',
  CREATE_UNTITLED_FILE: 'vault:create-untitled-file',
  CREATE_UNTITLED_FILE_IN_FOLDER: 'vault:create-untitled-file-in-folder',
  CREATE_FOLDER: 'vault:create-folder',
  RENAME_FILE: 'vault:rename-file',
  DELETE_FILE: 'vault:delete-file',
  /** 在系统文件管理器中打开某个文件夹 */
  OPEN_FOLDER: 'vault:open-folder',
  /** 在系统文件管理器中定位某个文件（选中它） */
  SHOW_FILE_IN_FOLDER: 'vault:show-file-in-folder',
  SET_USER_CONTEXT: 'vault:set-user-context',
  /** 主进程 → 渲染进程：请求把某篇笔记/文件夹展示到右侧 Vault 标签 */
  PRESENT_REQUESTED: 'vault:present-requested',
  /** 主进程 → 渲染进程：取消未决展示请求 */
  PRESENT_CANCELLED: 'vault:presentation-cancelled',
  /** 渲染进程 → 主进程：回执展示结果 */
  COMPLETE_PRESENTATION: 'vault:complete-presentation',
} as const
