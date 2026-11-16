/**
 * 企业 Skills 服务
 *
 * 移植自官方 0.22.0 `src/main/lib/enterprise-skills-service.ts`。
 *
 * 本文件承担可离线验证的全部逻辑：
 * - 制品打包（`createEnterpriseSkillArtifact`）：跳过 `.source.json`、拒绝符号链接与敏感文件、
 *   限制文件数 / 解压体积 / 压缩包体积
 * - 制品解包（`extractEnterpriseSkillArtifact`）：ZIP Slip 防护、大小写重复路径、符号链接条目、
 *   `__MACOSX` 忽略、清单 SHA-256
 * - 清单校验（`calculateSkillManifest`）与安装基线比对（检测本地修改后拒绝覆盖）
 * - 工作区落盘（`installEnterpriseSkillArtifact`）：暂存目录 + 备份回滚，绝不半覆盖
 * - 发布 / 安装 / 更新检查的编排入口：只通过注入的 `EnterpriseSkillsCloudApi` 访问云端
 *
 * 云端发布、账号鉴权与下载签名 URL 依赖完整 Cloud 子系统（本地未移植），因此：
 * - 未注入 Cloud API 时，列表返回 `{ availability: { enabled: false } }`（与官方 API 失败时一致）
 * - 发布 / 单条获取 / 安装会抛出 `UNAVAILABLE` 错误，而不是伪造成功
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { ENTERPRISE_SKILL_SOURCE_FILE } from '@proma/shared'
import type {
  EnterpriseSkillArtifactDescriptor,
  EnterpriseSkillArtifactSummary,
  EnterpriseSkillErrorCode,
  EnterpriseSkillInstallDescriptor,
  EnterpriseSkillInstallResult,
  EnterpriseSkillLibraryItem,
  EnterpriseSkillManifestEntry,
  EnterpriseSkillPublishInput,
  EnterpriseSkillPublishVersionInput,
  EnterpriseSkillSource,
  EnterpriseSkillUpdateCheckResult,
  EnterpriseSkillVersionRef,
  EnterpriseSkillsListResult,
} from '@proma/shared'
import { getDefaultSkillsDir, getInactiveSkillsDir, getWorkspaceSkillsDir } from './config-paths'
import { writeTextFileAtomic } from './safe-file'

/** 企业 Skills 云端 API 路径（本地未接入，保留官方常量便于后续对齐） */
export const ENTERPRISE_SKILLS_API_PATH = '/enterprise/skills'

/** 压缩包上限：10 MB */
export const MAX_ENTERPRISE_SKILL_ARCHIVE_BYTES = 10 * 1024 * 1024
/** 解压后上限：30 MB */
export const MAX_ENTERPRISE_SKILL_EXTRACTED_BYTES = 30 * 1024 * 1024
/** 单 Skill 文件数上限 */
export const MAX_ENTERPRISE_SKILL_FILES = 200

/** 制品内禁止上传的文件名（小写比较） */
const BLOCKED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
])

/** 敏感路径片段（仅在补前导 `/` 后比较，避免 `.aws/credentials` 这类根级路径漏检） */
const BLOCKED_PATH_SEGMENTS: readonly string[] = ['/.ssh/', '/.aws/']

/** 敏感扩展名 */
const BLOCKED_EXTENSION_PATTERN = /\.(pem|key|p12|pfx)$/

/** 相对路径分隔符（ZIP 内统一为 POSIX） */
const ARCHIVE_ROOT = '/enterprise-skill'

/**
 * safe-file 原子写在崩溃时可能留下的临时文件。
 * 它们不属于 Skill 内容，跳过以免进入制品或清单，保证 manifest 稳定。
 */
const SAFE_FILE_TMP_PATTERN = /^\..*\.proma-[0-9a-f]{24}\.tmp$/

/** 企业 Skills 错误：带分类码，便于 IPC / UI 区分校验、冲突与网络失败 */
export class EnterpriseSkillsError extends Error {
  readonly code: EnterpriseSkillErrorCode

  constructor(message: string, code: EnterpriseSkillErrorCode = 'NETWORK') {
    super(message)
    this.name = 'EnterpriseSkillsError'
    this.code = code
  }
}

/**
 * 云端企业 Skills 接口。
 *
 * 本地未实现任何具体传输；后续 Cloud 子系统移植完成后通过
 * `setEnterpriseSkillsCloudApi` 注入。方法签名与官方 HTTP 调用一一对应。
 */
export interface EnterpriseSkillsCloudApi {
  list(): Promise<EnterpriseSkillsListResult>
  get(skillId: string): Promise<EnterpriseSkillLibraryItem>
  publish(artifact: Buffer, input: EnterpriseSkillPublishInput): Promise<EnterpriseSkillLibraryItem>
  publishVersion(skillId: string, artifact: Buffer, input: EnterpriseSkillPublishVersionInput): Promise<EnterpriseSkillVersionRef>
  requestArtifactDownload(skillId: string, versionId: string): Promise<EnterpriseSkillArtifactDescriptor>
  fetchArtifact(url: string, signal?: AbortSignal): Promise<Response>
  checkUpdates(installed: EnterpriseSkillInstalledRef[]): Promise<EnterpriseSkillUpdateCheckResult>
}

/** 已安装企业 Skill 的版本引用（用于更新检查） */
export interface EnterpriseSkillInstalledRef {
  skillId: string
  versionId: string
  version: string
}

/** 工作区目录布局；测试可注入临时目录，生产使用 config-paths */
export interface EnterpriseSkillWorkspaceLayout {
  getWorkspaceSkillsDir(workspaceSlug: string): string
  getInactiveSkillsDir(workspaceSlug: string): string
  getDefaultSkillSlugs(): string[]
}

let cloudApi: EnterpriseSkillsCloudApi | undefined

/** 注入云端实现；传 `undefined` 恢复“未接入”状态 */
export function setEnterpriseSkillsCloudApi(api: EnterpriseSkillsCloudApi | undefined): void {
  cloudApi = api
}

export function getEnterpriseSkillsCloudApi(): EnterpriseSkillsCloudApi | undefined {
  return cloudApi
}

function requireCloudApi(): EnterpriseSkillsCloudApi {
  if (!cloudApi) {
    throw new EnterpriseSkillsError('云端企业 Skills 服务尚未接入', 'UNAVAILABLE')
  }
  return cloudApi
}

/** 生产环境布局：读取 ~/.proma 下的工作区与默认 Skills 目录 */
export function createDefaultEnterpriseSkillLayout(): EnterpriseSkillWorkspaceLayout {
  return {
    getWorkspaceSkillsDir,
    getInactiveSkillsDir,
    getDefaultSkillSlugs(): string[] {
      try {
        return readdirSync(getDefaultSkillsDir(), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
  }
}

const defaultLayout = createDefaultEnterpriseSkillLayout()

// ===== 纯校验 =====

/** 计算 SHA-256 十六进制摘要 */
function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 归档路径是否安全：拒绝绝对路径、盘符、`..` 穿越与空名 */
export function isSafeArchivePath(name: string): boolean {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false
  const target = resolve(ARCHIVE_ROOT, normalized)
  const relativePath = relative(ARCHIVE_ROOT, target)
  return relativePath !== '' && !relativePath.startsWith('..')
}

/** Skill slug 只允许小写字母/数字/连字符，最长 100 */
export function assertSafeSkillSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new EnterpriseSkillsError('Skill 标识不合法', 'VALIDATION')
  }
}

/** 拒绝会泄露凭据的文件；上传与解包两侧共用 */
export function assertNoSensitiveFile(relativePath: string): void {
  const lower = relativePath.replace(/\\/g, '/').toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  const probe = `/${lower}`
  const hitsBlockedSegment = BLOCKED_PATH_SEGMENTS.some((segment) => probe.includes(segment))
  if (BLOCKED_FILE_NAMES.has(name) || hitsBlockedSegment || BLOCKED_EXTENSION_PATTERN.test(name)) {
    throw new EnterpriseSkillsError(`制品包含禁止上传的敏感文件: ${relativePath}`, 'VALIDATION')
  }
}

/** 判断 `.source.json` 是否为企业库来源 */
export function isEnterpriseSkillSource(value: unknown): value is EnterpriseSkillSource {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EnterpriseSkillSource>
  return candidate.type === 'enterprise-library'
    && candidate.schemaVersion === 2
    && typeof candidate.skillId === 'string'
    && typeof candidate.versionId === 'string'
}

// ===== 来源元数据 =====

/** 读取企业来源标记；文件缺失、损坏或不是企业来源时返回 undefined */
export function readEnterpriseSkillSource(skillDir: string): EnterpriseSkillSource | undefined {
  const sourcePath = join(skillDir, ENTERPRISE_SKILL_SOURCE_FILE)
  if (!existsSync(sourcePath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(sourcePath, 'utf-8'))
    return isEnterpriseSkillSource(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 原子写入来源标记（沿目录内随机临时文件 + rename，不产生 `.bak` 残留） */
export function writeEnterpriseSkillSource(skillDir: string, source: EnterpriseSkillSource): void {
  writeTextFileAtomic(join(skillDir, ENTERPRISE_SKILL_SOURCE_FILE), JSON.stringify(source, null, 2))
}

// ===== 目录遍历 / 清单 =====

interface EnterpriseSkillFileEntry {
  absolutePath: string
  relativePath: string
}

/** 递归收集 Skill 文件；拒绝符号链接，跳过来源标记与原子写残留 */
function walkSkillFiles(
  root: string,
  current: string = root,
  files: EnterpriseSkillFileEntry[] = [],
): EnterpriseSkillFileEntry[] {
  const entries: Dirent[] = readdirSync(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ENTERPRISE_SKILL_SOURCE_FILE || SAFE_FILE_TMP_PATTERN.test(entry.name)) continue
    const absolutePath = join(current, entry.name)
    const relativePath = relative(root, absolutePath).split(/\\/).join('/')
    if (entry.isSymbolicLink()) {
      throw new EnterpriseSkillsError(`不允许符号链接: ${relativePath}`, 'VALIDATION')
    }
    if (entry.isDirectory()) {
      walkSkillFiles(root, absolutePath, files)
      continue
    }
    if (!entry.isFile()) continue
    assertNoSensitiveFile(relativePath)
    files.push({ absolutePath, relativePath })
    if (files.length > MAX_ENTERPRISE_SKILL_FILES) {
      throw new EnterpriseSkillsError(`Skill 文件数超过 ${MAX_ENTERPRISE_SKILL_FILES} 个`, 'VALIDATION')
    }
  }
  return files
}

/**
 * 计算 Skill 目录内容清单的 SHA-256。
 *
 * 清单按路径排序后序列化；`.source.json` 不参与计算，因此安装前后可比较。
 */
export function calculateSkillManifest(skillDir: string): string {
  const manifest: EnterpriseSkillManifestEntry[] = walkSkillFiles(skillDir)
    .filter((file) => file.relativePath !== ENTERPRISE_SKILL_SOURCE_FILE)
    .map((file) => ({
      path: file.relativePath,
      size: statSync(file.absolutePath).size,
      sha256: sha256Hex(readFileSync(file.absolutePath)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return sha256Hex(Buffer.from(JSON.stringify(manifest)))
}

// ===== 制品打包 / 解包 =====

/** 把本地 Skill 目录打成 ZIP 制品；大小与文件数超限时抛 VALIDATION */
export function createEnterpriseSkillArtifact(skillDir: string): Buffer {
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    throw new EnterpriseSkillsError('Skill 缺少 SKILL.md', 'VALIDATION')
  }

  const zip = new AdmZip()
  let totalSize = 0
  for (const file of walkSkillFiles(skillDir)) {
    const contents = readFileSync(file.absolutePath)
    totalSize += contents.length
    if (totalSize > MAX_ENTERPRISE_SKILL_EXTRACTED_BYTES) {
      throw new EnterpriseSkillsError('Skill 解压后大小超过 30 MB', 'VALIDATION')
    }
    zip.addFile(file.relativePath, contents)
  }

  const artifact = zip.toBuffer()
  if (artifact.length > MAX_ENTERPRISE_SKILL_ARCHIVE_BYTES) {
    throw new EnterpriseSkillsError('Skill 压缩包超过 10 MB', 'VALIDATION')
  }
  return artifact
}

/**
 * 解包企业 Skill 制品到指定目录。
 *
 * 安全约束（与官方一致）：
 * - 压缩包 1 字节 ~ 10 MB，条目数 1 ~ 200
 * - 拒绝符号链接条目（external attributes 的 S_IFLNK）
 * - 拒绝绝对路径 / 盘符 / `..` 穿越 / `__MACOSX/`
 * - 大小写不敏感去重，避免 Windows 覆盖
 * - 解压总量 <= 30 MB
 * - 必须包含 `SKILL.md`
 */
export function extractEnterpriseSkillArtifact(artifact: Buffer, destination: string): EnterpriseSkillArtifactSummary {
  if (artifact.length === 0 || artifact.length > MAX_ENTERPRISE_SKILL_ARCHIVE_BYTES) {
    throw new EnterpriseSkillsError('制品大小无效或超过 10 MB', 'INTEGRITY')
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(artifact)
  } catch {
    throw new EnterpriseSkillsError('制品压缩包无法解析', 'INTEGRITY')
  }

  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  if (entries.length === 0 || entries.length > MAX_ENTERPRISE_SKILL_FILES) {
    throw new EnterpriseSkillsError(`制品文件数必须为 1-${MAX_ENTERPRISE_SKILL_FILES}`, 'INTEGRITY')
  }

  const seen = new Set<string>()
  let totalSize = 0
  const manifest: EnterpriseSkillManifestEntry[] = []

  for (const entry of entries) {
    const attr = typeof entry.attr === 'number' ? entry.attr : 0
    if (((attr >>> 16) & 0o170000) === 0o120000) {
      throw new EnterpriseSkillsError(`制品包含符号链接: ${entry.entryName}`, 'INTEGRITY')
    }

    const entryName = entry.entryName.replace(/\\/g, '/')
    if (!isSafeArchivePath(entryName) || entryName.startsWith('__MACOSX/')) {
      throw new EnterpriseSkillsError(`制品存在非法路径: ${entry.entryName}`, 'INTEGRITY')
    }

    const lower = entryName.toLowerCase()
    if (seen.has(lower)) {
      throw new EnterpriseSkillsError(`制品存在重复路径: ${entry.entryName}`, 'INTEGRITY')
    }
    seen.add(lower)
    assertNoSensitiveFile(entryName)

    // 先按头部声明大小累计，避免明显超限的压缩炸弹进入解压。
    const declaredSize = typeof entry.header?.size === 'number' ? entry.header.size : 0
    totalSize += declaredSize
    if (totalSize > MAX_ENTERPRISE_SKILL_EXTRACTED_BYTES) {
      throw new EnterpriseSkillsError('制品解压后超过 30 MB', 'INTEGRITY')
    }

    let contents: Buffer
    try {
      contents = entry.getData()
    } catch {
      throw new EnterpriseSkillsError(`制品条目无法解压: ${entry.entryName}`, 'INTEGRITY')
    }
    // 头部声明不可信时以真实字节数为准。
    totalSize += contents.length - declaredSize
    if (totalSize > MAX_ENTERPRISE_SKILL_EXTRACTED_BYTES) {
      throw new EnterpriseSkillsError('制品解压后超过 30 MB', 'INTEGRITY')
    }

    const output = join(destination, entryName)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, contents)
    manifest.push({ path: entryName, size: contents.length, sha256: sha256Hex(contents) })
  }

  if (!seen.has('skill.md')) {
    throw new EnterpriseSkillsError('制品缺少 SKILL.md', 'INTEGRITY')
  }

  manifest.sort((a, b) => a.path.localeCompare(b.path))
  return { fileCount: entries.length, manifestSha256: sha256Hex(Buffer.from(JSON.stringify(manifest))) }
}

// ===== 工作区定位 =====

/** 查找 Skill 目录（active 优先，其次 inactive） */
export function findEnterpriseSkillDir(
  workspaceSlug: string,
  skillSlug: string,
  layout: EnterpriseSkillWorkspaceLayout = defaultLayout,
): string | undefined {
  const active = join(layout.getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  if (existsSync(active)) return active
  const inactive = join(layout.getInactiveSkillsDir(workspaceSlug), skillSlug)
  return existsSync(inactive) ? inactive : undefined
}

// ===== 安装 =====

/** 本地安装输入：制品已下载并校验通过 */
export interface EnterpriseSkillArtifactInstallInput {
  workspaceSlug: string
  skill: EnterpriseSkillInstallDescriptor
  enterpriseId: string
  artifact: Buffer
  /** 制品 SHA-256（十六进制，大小写不敏感） */
  artifactSha256: string
  layout?: EnterpriseSkillWorkspaceLayout
}

/**
 * 把已校验的制品安装到工作区。
 *
 * 规则（与官方一致）：
 * - 禁止覆盖默认内置 Skill
 * - 同名目录存在但来源不是同一 `skillId` 时拒绝
 * - 已安装且本地内容与 `baseManifestSha256` 不一致时拒绝自动覆盖
 * - 先解包到暂存目录，再整体替换；失败时用备份回滚
 */
export function installEnterpriseSkillArtifact(input: EnterpriseSkillArtifactInstallInput): EnterpriseSkillInstallResult {
  const layout = input.layout ?? defaultLayout
  const { skill } = input
  assertSafeSkillSlug(skill.slug)

  if (layout.getDefaultSkillSlugs().includes(skill.slug)) {
    throw new EnterpriseSkillsError('不能覆盖 PROMA 内置 Skill', 'CONFLICT')
  }

  const existing = findEnterpriseSkillDir(input.workspaceSlug, skill.slug, layout)
  const existingSource = existing ? readEnterpriseSkillSource(existing) : undefined
  if (existing && (!existingSource || existingSource.skillId !== skill.id)) {
    throw new EnterpriseSkillsError('已有同名 Skill 且来源不同，请先手动处理冲突', 'CONFLICT')
  }

  const skillsDir = existing ? dirname(existing) : layout.getWorkspaceSkillsDir(input.workspaceSlug)
  mkdirSync(skillsDir, { recursive: true })
  const staging = join(skillsDir, `.${skill.slug}.enterprise-${randomUUID()}`)
  const backup = join(skillsDir, `.${skill.slug}.backup-${randomUUID()}`)
  const target = existing ?? join(skillsDir, skill.slug)

  try {
    const extracted = extractEnterpriseSkillArtifact(input.artifact, staging)
    const source: EnterpriseSkillSource = {
      schemaVersion: 2,
      type: 'enterprise-library',
      enterpriseId: input.enterpriseId,
      skillId: skill.id,
      versionId: skill.latestVersion.id,
      installedVersion: skill.latestVersion.version,
      artifactSha256: input.artifactSha256.toLowerCase(),
      baseManifestSha256: extracted.manifestSha256,
      installedAt: new Date().toISOString(),
    }
    writeEnterpriseSkillSource(staging, source)

    if (existing) {
      if (existingSource?.baseManifestSha256 && existingSource.baseManifestSha256 !== calculateSkillManifest(existing)) {
        throw new EnterpriseSkillsError('本地 Skill 已修改，拒绝自动覆盖', 'CONFLICT')
      }
      rmSync(backup, { recursive: true, force: true })
      renameSync(existing, backup)
    }

    renameSync(staging, target)
    if (existsSync(backup)) {
      try {
        rmSync(backup, { recursive: true, force: true })
      } catch (error) {
        // 备份清理失败不应让已经完成的替换报错；残留目录带 `.` 前缀，不会被扫描为 Skill。
        console.warn(`[企业 Skills] 备份清理失败: ${backup}`, error)
      }
    }
    return {
      skillId: skill.id,
      versionId: skill.latestVersion.id,
      installedVersion: skill.latestVersion.version,
      source,
    }
  } catch (error) {
    try {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
      if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
    } catch (cleanupError) {
      console.warn(`[企业 Skills] 安装回滚失败: ${input.workspaceSlug}/${skill.slug}`, cleanupError)
    }
    throw error
  }
}

/** 下载并校验制品；任何大小 / 摘要不符都拒绝 */
async function downloadEnterpriseSkillArtifact(
  api: EnterpriseSkillsCloudApi,
  skillId: string,
  versionId: string,
): Promise<EnterpriseSkillArtifactDescriptor & { artifact: Buffer }> {
  const descriptor = await api.requestArtifactDownload(skillId, versionId)
  if (!descriptor.url || !/^[a-fA-F0-9]{64}$/.test(descriptor.artifactSha256)) {
    throw new EnterpriseSkillsError('服务端返回的制品信息无效', 'INTEGRITY')
  }

  const response = await api.fetchArtifact(descriptor.url)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new EnterpriseSkillsError(`制品下载失败 (${response.status})`, 'NETWORK')
  }
  if (!response.body) {
    throw new EnterpriseSkillsError('制品响应为空', 'INTEGRITY')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_ENTERPRISE_SKILL_ARCHIVE_BYTES) {
        throw new EnterpriseSkillsError('制品超出大小限制', 'INTEGRITY')
      }
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  const artifact = Buffer.concat(chunks, length)
  if (artifact.length > MAX_ENTERPRISE_SKILL_ARCHIVE_BYTES || sha256Hex(artifact) !== descriptor.artifactSha256.toLowerCase()) {
    throw new EnterpriseSkillsError('制品完整性校验失败', 'INTEGRITY')
  }
  return { ...descriptor, artifact }
}

/** 从企业库安装 Skill（需要云端 API） */
export async function installEnterpriseSkill(
  workspaceSlug: string,
  skill: EnterpriseSkillInstallDescriptor,
): Promise<EnterpriseSkillInstallResult> {
  assertSafeSkillSlug(skill.slug)

  if (defaultLayout.getDefaultSkillSlugs().includes(skill.slug)) {
    throw new EnterpriseSkillsError('不能覆盖 PROMA 内置 Skill', 'CONFLICT')
  }

  const existing = findEnterpriseSkillDir(workspaceSlug, skill.slug)
  const existingSource = existing ? readEnterpriseSkillSource(existing) : undefined
  if (existing && (!existingSource || existingSource.skillId !== skill.id)) {
    throw new EnterpriseSkillsError('已有同名 Skill 且来源不同，请先手动处理冲突', 'CONFLICT')
  }

  const api = requireCloudApi()
  const enterpriseId = skill.enterpriseId
    ?? existingSource?.enterpriseId
    ?? (await getEnterpriseSkill(skill.id)).policy?.enterpriseId
  if (!enterpriseId) {
    throw new EnterpriseSkillsError('服务端未返回企业标识，无法安全安装', 'UNAVAILABLE')
  }

  const download = await downloadEnterpriseSkillArtifact(api, skill.id, skill.latestVersion.id)
  return installEnterpriseSkillArtifact({
    workspaceSlug,
    skill,
    enterpriseId,
    artifact: download.artifact,
    artifactSha256: download.artifactSha256.toLowerCase(),
  })
}

// ===== 发布 =====

/** 发布后把服务端返回的企业来源写回 Skill 目录 */
function savePublishedEnterpriseSource(input: {
  skillDir: string
  enterpriseId: string
  skillId: string
  version: EnterpriseSkillVersionRef
}): void {
  const previous = readEnterpriseSkillSource(input.skillDir)
  const source: EnterpriseSkillSource = {
    schemaVersion: 2,
    type: 'enterprise-library',
    enterpriseId: input.enterpriseId,
    skillId: input.skillId,
    versionId: input.version.id,
    installedVersion: input.version.version,
    artifactSha256: input.version.artifactSha256 ?? previous?.artifactSha256 ?? '',
    baseManifestSha256: calculateSkillManifest(input.skillDir),
    installedAt: previous?.installedAt ?? new Date().toISOString(),
  }
  writeEnterpriseSkillSource(input.skillDir, source)
}

/** 发布新 Skill 到企业库；云端未接入时抛 UNAVAILABLE */
export async function publishEnterpriseSkill(
  workspaceSlug: string,
  input: EnterpriseSkillPublishInput,
): Promise<EnterpriseSkillLibraryItem> {
  assertSafeSkillSlug(input.skillSlug)
  const skillDir = findEnterpriseSkillDir(workspaceSlug, input.skillSlug)
  if (!skillDir) {
    throw new EnterpriseSkillsError('本地 Skill 不存在', 'VALIDATION')
  }

  const api = requireCloudApi()
  const artifact = createEnterpriseSkillArtifact(skillDir)
  const published = await api.publish(artifact, input)
  const enterpriseId = published.policy?.enterpriseId
  if (enterpriseId) {
    savePublishedEnterpriseSource({ skillDir, enterpriseId, skillId: published.id, version: published.latestVersion })
  }
  return published
}

/** 为已有企业 Skill 发布新版本 */
export async function publishEnterpriseSkillVersion(
  workspaceSlug: string,
  skillId: string,
  input: EnterpriseSkillPublishVersionInput,
): Promise<EnterpriseSkillVersionRef> {
  assertSafeSkillSlug(input.skillSlug)
  const skillDir = findEnterpriseSkillDir(workspaceSlug, input.skillSlug)
  if (!skillDir) {
    throw new EnterpriseSkillsError('本地 Skill 不存在', 'VALIDATION')
  }

  const api = requireCloudApi()
  const artifact = createEnterpriseSkillArtifact(skillDir)
  const published = await api.publishVersion(skillId, artifact, input)
  const source = readEnterpriseSkillSource(skillDir)
  if (source?.skillId === skillId) {
    savePublishedEnterpriseSource({ skillDir, enterpriseId: source.enterpriseId, skillId, version: published })
  }
  return published
}

// ===== 查询 / 更新检查 =====

/** 列出企业库 Skill；云端不可用或请求失败时返回禁用状态（官方行为） */
export async function getEnterpriseSkills(): Promise<EnterpriseSkillsListResult> {
  const api = getEnterpriseSkillsCloudApi()
  if (!api) {
    return { items: [], availability: { enabled: false, reason: '云端企业 Skills 服务尚未接入' } }
  }
  try {
    return await api.list()
  } catch (error) {
    return { items: [], availability: { enabled: false, reason: enterpriseSkillsErrorMessage(error) } }
  }
}

/** 获取单个企业库 Skill；云端未接入或失败时抛 UNAVAILABLE */
export async function getEnterpriseSkill(skillId: string): Promise<EnterpriseSkillLibraryItem> {
  try {
    return await requireCloudApi().get(skillId)
  } catch (error) {
    if (error instanceof EnterpriseSkillsError && error.code === 'UNAVAILABLE') throw error
    throw new EnterpriseSkillsError(enterpriseSkillsErrorMessage(error), 'UNAVAILABLE')
  }
}

/**
 * 检查已安装企业 Skill 的更新。
 *
 * 没有任何已安装企业 Skill、云端未接入或请求失败时返回空更新列表（官方行为）。
 */
export async function checkEnterpriseSkillUpdates(
  workspaceSlug: string,
  skills: ReadonlyArray<{ slug: string }>,
  layout: EnterpriseSkillWorkspaceLayout = defaultLayout,
): Promise<EnterpriseSkillUpdateCheckResult> {
  const installed: EnterpriseSkillInstalledRef[] = skills.flatMap((skill) => {
    const dir = findEnterpriseSkillDir(workspaceSlug, skill.slug, layout)
    const source = dir ? readEnterpriseSkillSource(dir) : undefined
    return source ? [{ skillId: source.skillId, versionId: source.versionId, version: source.installedVersion }] : []
  })
  if (installed.length === 0) return { updates: [] }

  const api = getEnterpriseSkillsCloudApi()
  if (!api) return { updates: [] }

  try {
    return await api.checkUpdates(installed)
  } catch {
    return { updates: [] }
  }
}

/** 统一的错误文案提取 */
function enterpriseSkillsErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return '企业 Skills 服务暂时不可用'
}
