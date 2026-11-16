/**
 * Skill 真实使用记录解析
 *
 * 只认可两类结构化证据：
 * 1. 会话消息上由运行时写入的 `skill_activations` 元数据（含显式 `/skill:` 展开与
 *    成功读取 SKILL.md 的归并结果）；
 * 2. 成功完成的 Skill 入口文件读取工具结果（旧会话没有元数据时的回退）。
 *
 * 普通对话正文、系统提示词里的 Skill 名称、`<available_skills>` 列表，以及
 * 用户或模型手写的 `<skill name="..." location="...">` 文本都不算使用。
 */

import type {
  SDKMessage,
  SkillActivation,
} from '@proma/shared'
import {
  collectSuccessfulSkillReadActivations,
  mergeSkillActivations,
} from '@proma/shared'

/** 单条真实 Skill 激活记录。 */
export interface SkillActivationRecord {
  /**
   * 规范化后的 Skill 入口路径。
   *
   * - 能归属到当前工作区时为工作区相对路径：`<slug>/SKILL.md`；
   * - 无法归属到工作区时回退为规范化绝对路径。
   */
  skillPath: string
  /** Skill 展示名（frontmatter name；缺失时回退 slug）。 */
  skillName: string
  /** 激活时间；消息无独立时间戳时取调用方提供的会话活动时间，未知为 0。 */
  activatedAt: number
}

/** 解析可选上下文；提供工作区信息后只保留能归属到该工作区的激活。 */
export interface ParseSkillActivationsOptions {
  /** 当前工作区 slug。 */
  workspaceSlug?: string
  /** 当前工作区 skills 目录绝对路径，用于校验激活路径归属。 */
  workspaceSkillsRoot?: string
  /** 会话最近活动时间，作为消息级时间戳缺失时的激活时间。 */
  sessionActivityAt?: number
}

/** 工作区内 Skill 入口相对路径，例如 `my-skill/SKILL.md`。 */
const WORKSPACE_SKILL_PATH_PATTERN = /^([^/]+)\/SKILL\.md$/i
/** 任意路径中的 `skills/<slug>/SKILL.md` 片段。 */
const SKILL_ENTRY_PATH_PATTERN = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i
/** Proma 托管工作区路径中的 `agent-workspaces/<slug>/skills/<skill>/SKILL.md`。 */
const MANAGED_WORKSPACE_PATH_PATTERN = /\/agent-workspaces\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/i

interface ResolvedActivation {
  skillPath: string
  skillName: string
}

interface ParsedStructuredActivations {
  records: SkillActivationRecord[]
  skillPaths: Set<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受带字符串 `type` 的对象；JSONL 损坏行产生的标量一律跳过。 */
function isSdkMessageLike(value: unknown): value is SDKMessage {
  return isRecord(value) && typeof value.type === 'string'
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:)?\//.test(normalizePath(path))
}

/** 判断 path 是否位于 root 之内；Windows 盘符路径按大小写不敏感比较。 */
function isPathInside(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root)
  const normalizedPath = normalizePath(path)
  if (!normalizedRoot || !normalizedPath) return false
  const caseInsensitive = /^[a-zA-Z]:\//.test(normalizedRoot)
  const lhs = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
  const rhs = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  return lhs.startsWith(`${rhs}/`)
}

/** 从绝对路径解析 `agent-workspaces/<slug>/skills/...` 里的工作区 slug。 */
function extractWorkspaceSlug(path: string): string | undefined {
  return MANAGED_WORKSPACE_PATH_PATTERN.exec(normalizePath(path))?.[1]
}

/** 从 `skills/<slug>/SKILL.md` 或相对入口路径里解析 Skill slug。 */
function extractSkillSlug(path: string): string | undefined {
  const normalized = normalizePath(path)
  const relativeMatch = WORKSPACE_SKILL_PATH_PATTERN.exec(normalized)
  if (relativeMatch) return relativeMatch[1]
  return SKILL_ENTRY_PATH_PATTERN.exec(normalized)?.[1]
}

function readMessageTimestamp(message: Record<string, unknown>): number | undefined {
  const raw = message.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/**
 * 判断一条激活记录的归属并生成统计键。
 *
 * 返回 null 表示证据明确指向其它工作区或外部 Skill 根，必须丢弃；
 * 没有归属信息时按“会话本身已按工作区过滤”这一前提归入当前工作区。
 */
function resolveActivation(
  activation: SkillActivation,
  options: ParseSkillActivationsOptions,
): ResolvedActivation | null {
  const filePath = activation.filePath ? normalizePath(activation.filePath) : undefined
  const relativeSkillPath = activation.workspaceSkillPath
    ? normalizePath(activation.workspaceSkillPath)
    : undefined
  const workspaceFromPath = filePath ? extractWorkspaceSlug(filePath) : undefined
  const declaredWorkspace = activation.workspaceSlug?.trim() || workspaceFromPath
  const skillSlug = extractSkillSlug(relativeSkillPath ?? filePath ?? '') ?? activation.slug

  if (options.workspaceSlug) {
    if (declaredWorkspace && declaredWorkspace !== options.workspaceSlug) return null

    if (relativeSkillPath && WORKSPACE_SKILL_PATH_PATTERN.test(relativeSkillPath)) {
      return { skillPath: relativeSkillPath, skillName: activation.name }
    }

    if (filePath) {
      const insideWorkspace = workspaceFromPath === options.workspaceSlug
        || Boolean(options.workspaceSkillsRoot && isPathInside(options.workspaceSkillsRoot, filePath))
      if (!insideWorkspace && isAbsolutePath(filePath)) return null
      return { skillPath: `${skillSlug}/SKILL.md`, skillName: activation.name }
    }

    return { skillPath: `${activation.slug}/SKILL.md`, skillName: activation.name }
  }

  if (relativeSkillPath && WORKSPACE_SKILL_PATH_PATTERN.test(relativeSkillPath)) {
    return { skillPath: relativeSkillPath, skillName: activation.name }
  }
  if (filePath) {
    if (workspaceFromPath) {
      return { skillPath: `${skillSlug}/SKILL.md`, skillName: activation.name }
    }
    return { skillPath: filePath, skillName: activation.name }
  }
  return { skillPath: `${activation.slug}/SKILL.md`, skillName: activation.name }
}

function readStoredActivations(
  message: Record<string, unknown>,
  options: ParseSkillActivationsOptions,
): SkillActivation[] {
  const raw = message.skill_activations
  if (!Array.isArray(raw)) return []

  // 明示了其它工作区的条目直接丢弃：mergeSkillActivations 会丢弃缺少路径的
  // workspaceSlug，等到归属阶段再判断就晚了。
  const declaredWorkspace = options.workspaceSlug
  const usable = declaredWorkspace
    ? raw.filter((entry) => {
        if (!isRecord(entry) || typeof entry.workspaceSlug !== 'string') return true
        return entry.workspaceSlug.trim() === '' || entry.workspaceSlug.trim() === declaredWorkspace
      })
    : raw

  return mergeSkillActivations(usable as readonly SkillActivation[])
}

/** 过滤损坏的内容块，避免旧会话里的 null/标量块让 Read 回退解析抛错。 */
function sanitizeContentBlocks(message: SDKMessage): SDKMessage {
  const record = message as unknown as Record<string, unknown>
  const messageValue = record.message
  if (!isRecord(messageValue) || !Array.isArray(messageValue.content)) return message

  const content = messageValue.content.filter(
    (block) => isRecord(block) && typeof block.type === 'string',
  )
  if (content.length === messageValue.content.length) return message
  return { ...record, message: { ...messageValue, content } } as unknown as SDKMessage
}

function appendActivation(
  target: SkillActivationRecord[],
  skillPaths: Set<string>,
  activation: SkillActivation,
  activatedAt: number,
  options: ParseSkillActivationsOptions,
  skipExisting = false,
): boolean {
  const resolved = resolveActivation(activation, options)
  if (!resolved) return false
  if (skipExisting && skillPaths.has(resolved.skillPath)) return false
  target.push({
    skillPath: resolved.skillPath,
    skillName: resolved.skillName,
    activatedAt,
  })
  skillPaths.add(resolved.skillPath)
  return true
}

/**
 * 解析一组会话消息里的真实 Skill 激活。
 *
 * 计数口径：
 * - 每条 user 消息上的激活元数据算一次使用（同一消息内按 Skill 去重）；
 * - 会话完全没有 user 元数据时才回退到 result 元数据，且同一 Skill 每会话只算一次，
 *   避免运行时把累计激活写进多个 result 造成重复计数；
 * - 成功读取入口文件的回退只补充元数据里没有出现的 Skill，每会话最多一次。
 */
export function parseSkillActivations(
  messages: readonly unknown[],
  options: ParseSkillActivationsOptions = {},
): SkillActivationRecord[] {
  const fallbackAt = options.sessionActivityAt ?? 0
  const sdkMessages = messages.filter(isSdkMessageLike)
  const structured = collectStructuredActivations(sdkMessages, fallbackAt, options)

  const records = structured.records
  const skillPaths = structured.skillPaths

  // 旧会话没有元数据时，用成功 Read 入口文件的证据回退；每会话同 Skill 只计一次。
  if (sdkMessages.length > 0) {
    const readActivations = collectSuccessfulSkillReadActivations(
      sdkMessages.map(sanitizeContentBlocks),
      {
        ...(options.workspaceSlug ? { workspaceSlug: options.workspaceSlug } : {}),
        ...(options.workspaceSkillsRoot ? { workspaceSkillsRoot: options.workspaceSkillsRoot } : {}),
      },
    )
    for (const activation of readActivations) {
      appendActivation(records, skillPaths, activation, fallbackAt, options, true)
    }
  }

  return records
}

function collectStructuredActivations(
  messages: readonly SDKMessage[],
  fallbackAt: number,
  options: ParseSkillActivationsOptions,
): ParsedStructuredActivations {
  const records: SkillActivationRecord[] = []
  const skillPaths = new Set<string>()

  const userMessages = messages.filter((message) => message.type === 'user')
  let hasStoredUserActivations = false

  for (const message of userMessages) {
    const record = message as unknown as Record<string, unknown>
    const activations = readStoredActivations(record, options)
    if (activations.length === 0) continue
    hasStoredUserActivations = true
    const activatedAt = readMessageTimestamp(record) ?? fallbackAt
    for (const activation of activations) {
      appendActivation(records, skillPaths, activation, activatedAt, options)
    }
  }

  if (hasStoredUserActivations) return { records, skillPaths }

  // 结果消息的元数据是整轮摘要，可能跨多个 result 重复；同 Skill 每会话只记一次。
  for (const message of messages) {
    if (message.type !== 'result') continue
    const record = message as unknown as Record<string, unknown>
    const activations = readStoredActivations(record, options)
    if (activations.length === 0) continue
    const activatedAt = readMessageTimestamp(record) ?? fallbackAt
    for (const activation of activations) {
      appendActivation(records, skillPaths, activation, activatedAt, options, true)
    }
  }

  return { records, skillPaths }
}
