/**
 * 企业 Skills 库相关类型
 *
 * 对应官方 0.22.0 `src/main/lib/enterprise-skills-service.ts`。
 * 本地只承担制品打包/解包/校验与工作区落盘；云端发布与下载接口尚未接入，
 * 由主进程注入 `EnterpriseSkillsCloudApi` 后再启用（见 deferred 说明）。
 */

/** Skill 目录内记录企业库来源的标记文件名 */
export const ENTERPRISE_SKILL_SOURCE_FILE = '.source.json'

/** 企业 Skills 安装来源（写入 `<skillDir>/.source.json`） */
export interface EnterpriseSkillSource {
  /** 固定为 2；与工作区导入来源（无 schemaVersion）区分 */
  schemaVersion: 2
  type: 'enterprise-library'
  enterpriseId: string
  skillId: string
  versionId: string
  /** 安装时的人类可读版本号 */
  installedVersion: string
  /** 下载制品的 SHA-256（十六进制小写） */
  artifactSha256: string
  /** 安装后 Skill 目录内容清单的 SHA-256，用于检测本地修改 */
  baseManifestSha256: string
  /** ISO 8601 */
  installedAt: string
}

/** 企业库中的 Skill 版本引用 */
export interface EnterpriseSkillVersionRef {
  id: string
  version: string
  /** 制品 SHA-256；发布响应可能为空 */
  artifactSha256?: string
  changelog?: string
  publishedAt?: string
}

/** 企业库返回的策略字段（当前只用到 enterpriseId） */
export interface EnterpriseSkillPolicy {
  enterpriseId?: string
}

/** 企业库 Skill 条目 */
export interface EnterpriseSkillLibraryItem {
  id: string
  slug: string
  name?: string
  description?: string
  enterpriseId?: string
  latestVersion: EnterpriseSkillVersionRef
  policy?: EnterpriseSkillPolicy
}

/** 安装时所需的最小 Skill 描述（来自企业库列表/详情） */
export interface EnterpriseSkillInstallDescriptor {
  id: string
  slug: string
  enterpriseId?: string
  latestVersion: EnterpriseSkillVersionRef
}

/** 企业 Skills 服务可用性；云端未接入时 `enabled: false` */
export interface EnterpriseSkillsAvailability {
  enabled: boolean
  reason?: string
}

/** `list` 返回结构 */
export interface EnterpriseSkillsListResult {
  items: EnterpriseSkillLibraryItem[]
  availability: EnterpriseSkillsAvailability
}

/** 制品下载描述符 */
export interface EnterpriseSkillArtifactDescriptor {
  url: string
  /** 64 位十六进制 SHA-256 */
  artifactSha256: string
  size?: number
}

/** 首次发布输入 */
export interface EnterpriseSkillPublishInput {
  skillSlug: string
  version: string
  changelog?: string
  name?: string
  description?: string
}

/** 追加版本输入 */
export interface EnterpriseSkillPublishVersionInput {
  skillSlug: string
  version: string
  changelog?: string
}

/** 安装结果 */
export interface EnterpriseSkillInstallResult {
  skillId: string
  versionId: string
  installedVersion: string
  source: EnterpriseSkillSource
}

/**
 * 更新检查条目。
 *
 * 官方实现只是把云端 JSON 原样转发给 renderer；这里只约束已确认存在的字段，
 * 其余字段通过索引签名透传，避免伪造云端契约。
 */
export interface EnterpriseSkillUpdateEntry {
  skillId: string
  latestVersionId?: string
  latestVersion?: string
  changelog?: string
  publishedAt?: string
  [key: string]: unknown
}

/** 更新检查结果 */
export interface EnterpriseSkillUpdateCheckResult {
  updates: EnterpriseSkillUpdateEntry[]
}

/** 制品清单条目 */
export interface EnterpriseSkillManifestEntry {
  /** 相对 Skill 根目录的 POSIX 路径 */
  path: string
  size: number
  sha256: string
}

/** 解包结果摘要 */
export interface EnterpriseSkillArtifactSummary {
  fileCount: number
  manifestSha256: string
}

/** 企业 Skills 错误分类，与官方 `EnterpriseSkillsError.code` 对齐 */
export type EnterpriseSkillErrorCode = 'VALIDATION' | 'INTEGRITY' | 'CONFLICT' | 'UNAVAILABLE' | 'NETWORK'

/**
 * 企业 Skills IPC 通道。
 *
 * 通道名与官方 0.22.0 `CLOUD_IPC_CHANNELS.ENTERPRISE_SKILLS_*` 完全一致，
 * 便于后续接入 Cloud 子系统时保持契约不变。
 */
export const ENTERPRISE_SKILLS_IPC_CHANNELS = {
  /** 列出企业库 Skill */
  LIST: 'cloud:enterprise-skills:list',
  /** 获取单个企业库 Skill */
  GET: 'cloud:enterprise-skills:get',
  /** 发布新 Skill 到企业库 */
  PUBLISH: 'cloud:enterprise-skills:publish',
  /** 发布已有 Skill 的新版本 */
  PUBLISH_VERSION: 'cloud:enterprise-skills:publish-version',
  /** 安装企业库 Skill 到工作区 */
  INSTALL: 'cloud:enterprise-skills:install',
  /** 检查已安装企业 Skill 的更新 */
  CHECK_UPDATES: 'cloud:enterprise-skills:check-updates',
} as const
